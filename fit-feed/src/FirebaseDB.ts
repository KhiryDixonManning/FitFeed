import {
  collection, addDoc, DocumentReference, getDocs, query, orderBy, where,
  doc, getDoc, setDoc, increment, deleteDoc, documentId, writeBatch,
} from "firebase/firestore";
import { getStorage, ref, deleteObject } from "firebase/storage";
import { db } from "../firebase";
import { FirebaseError } from "firebase/app";
import { type Category } from "./constants/categories";
import { toggleLikeTransactional, stageTasteBump } from "./interactionService";

export interface User {
    uid: string;
    email: string;
    displayName?: string;
    username?: string;
    photoURL?: string;
    createdAt?: string;
}

// Attached by the /feed endpoint only — explains why the ranking engine
// placed a post where it did. Absent when the feed falls back to unranked
// order (Railway unreachable) or for tabs that don't use ranked order.
export interface RankingFactors {
    contributions: {
        communityConfidence: number;
        trendingVelocity: number;
        conversationBoost: number;
        styleMatch: number;
    };
    freshnessTier: number;
    ageHours: number;
    matchedCategory: string | null;
}

export interface Post {
    id: string;
    authorId: string;
    content?: string;
    imageUrl?: string;
    category?: Category;
    likesCount: number;
    commentsCount?: number;
    createdAt: string;
    updatedAt?: string;
    outfitBreakdown?: string;
    likedBy?: string[];
    // Server-computed on feed responses: whether the *viewer* liked this post.
    // The feed API omits the full likedBy array, which is unbounded.
    likedByMe?: boolean;
    palette?: (string | { hex: string; name: string; percentage: number })[];
    aesthetic?: string;
    aestheticTags?: string[];
    detectedItems?: string[];
    styleDescription?: string;
    styleNotes?: string;
    aestheticScores?: Record<string, number>;
    analyzed?: boolean;
    // Additive (2026-08-27): written on NEW posts only — 'pending' at
    // creation, then server-owned: 'processing' while a worker holds the
    // post, 'complete'/'failed' once analysis resolves. Legacy posts lack
    // the field; every consumer must treat absence as unknown.
    analysisStatus?: 'pending' | 'processing' | 'complete' | 'failed';
    // How many analysis attempts have been spent on this post. Server-owned;
    // a post at the cap needs an operator to make it claimable again.
    analysisAttempts?: number;
    // Id of the comment the most recent commentsCount change accounted for.
    // Written only as part of an atomic comment batch; the rules use it to
    // prove the counter moved with a real comment.
    lastCommentId?: string;
    outfitName?: string;
    _rankingFactors?: RankingFactors;
}

export interface Comment {
    id: string;
    postId: string;
    authorId: string;
    authorEmail: string;
    content: string;
    createdAt: string;
}

export const addPost = async (post: Omit<Post, "id" | "createdAt">): Promise<{ ref: DocumentReference; id: string } | null> => {
    try {
        const docRef = await addDoc(collection(db, "posts"), {
            ...post,
            createdAt: new Date(),
        });
        console.log("Post created with ID:", docRef.id);
        return { ref: docRef, id: docRef.id };
    } catch (error: unknown) {
        if (error instanceof FirebaseError) {
            console.log(error.code);
            console.log(error.message);
        } else {
            console.log("Unknown error:", error);
        }
        return null;
    }
};

export const getPosts = async (): Promise<Post[]> => {
    try {
        const postsRef = collection(db, "posts");
        const q = query(postsRef, orderBy("createdAt", "desc"));
        const querySnapshot = await getDocs(q);
        const posts: Post[] = querySnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            createdAt: doc.data().createdAt?.toDate().toISOString() ?? new Date().toISOString(),
        } as Post));
        return posts;
    } catch (error: unknown) {
        if (error instanceof FirebaseError) {
            console.log(error.code);
            console.log(error.message);
        } else {
            console.log("Unknown error:", error);
        }
        return [];
    }
};

// Only this author's posts — avoids downloading the whole collection when a
// page (Profile, PublicProfile, Insights) needs one user's posts. No orderBy
// so the automatic single-field index suffices (no composite index deploy);
// one author's posts are few, so we sort client-side.
export const getPostsByAuthor = async (authorId: string): Promise<Post[]> => {
    try {
        const q = query(collection(db, "posts"), where("authorId", "==", authorId));
        const snapshot = await getDocs(q);
        return snapshot.docs
            .map(d => ({
                id: d.id,
                ...d.data(),
                createdAt: d.data().createdAt?.toDate?.()?.toISOString() ?? new Date().toISOString(),
            } as Post))
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    } catch (error) {
        console.error("[getPostsByAuthor] Error:", error);
        return [];
    }
};

// Fetch specific posts by id (e.g. the saved list) in chunks of 30 — the
// Firestore 'in' operator limit — instead of loading every post.
export const getPostsByIds = async (ids: string[]): Promise<Post[]> => {
    if (ids.length === 0) return [];
    try {
        const chunks: string[][] = [];
        for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));
        const snapshots = await Promise.all(chunks.map(chunk =>
            getDocs(query(collection(db, "posts"), where(documentId(), "in", chunk)))
        ));
        return snapshots.flatMap(s => s.docs.map(d => ({
            id: d.id,
            ...d.data(),
            createdAt: d.data().createdAt?.toDate?.()?.toISOString() ?? new Date().toISOString(),
        } as Post)));
    } catch (error) {
        console.error("[getPostsByIds] Error:", error);
        return [];
    }
};

/**
 * Toggle a like. Delegates to the transactional implementation that writes
 * posts/{id}/likes/{uid} alongside the counter - the unbounded likedBy array
 * is no longer written by any client path.
 */
export const toggleLike = async (postId: string, uid: string): Promise<boolean> => {
    try {
        return await toggleLikeTransactional(postId, uid);
    } catch (error) {
        console.log("Error toggling like:", error);
        return false;
    }
};

export const getUserPreferences = async (uid: string): Promise<Record<string, number>> => {
    try {
        const docRef = doc(db, "userPreferences", uid);
        const docSnap = await getDoc(docRef);
        return docSnap.exists() ? (docSnap.data() as Record<string, number>) : {};
    } catch (error) {
        console.log("Error fetching preferences:", error);
        return {};
    }
};

export const saveUserPreferences = async (uid: string, preferences: Record<string, number>): Promise<void> => {
    try {
        const docRef = doc(db, "userPreferences", uid);
        await setDoc(docRef, preferences);
    } catch (error) {
        console.log("Error saving preferences:", error);
    }
};

/**
 * NOTE: getComments uses a composite index on (postId ASC, createdAt ASC).
 * If this query fails with a "requires an index" error, click the link in the
 * browser console — it opens the Firebase Console to create the index automatically.
 */
export const getComments = async (postId: string): Promise<Comment[]> => {
    try {
        const q = query(
            collection(db, "comments"),
            where("postId", "==", postId),
            orderBy("createdAt", "asc")
        );
        const snapshot = await getDocs(q);
        const comments = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as Comment));
        console.log(`[getComments] Fetched ${comments.length} comments for post ${postId}`);
        return comments;
    } catch (error: unknown) {
        console.error("[getComments] Error:", error);
        if (error instanceof FirebaseError && error.code === "failed-precondition") {
            console.error("[getComments] Missing Firestore index. Click this link:", error.message);
        }
        return [];
    }
};

export const addComment = async (
    postId: string,
    authorId: string,
    authorEmail: string,
    content: string
): Promise<boolean> => {
    const trimmed = content.trim();
    if (!trimmed || trimmed.length > 1000) return false;

    try {
        // One atomic batch: the comment and the denormalised counter move
        // together, so a partial failure can no longer leave commentsCount
        // drifting away from the real number of comments. The security rules
        // only permit a +/-1 step on the counter, which this satisfies.
        const batch = writeBatch(db);
        const commentRef = doc(collection(db, "comments"));
        batch.set(commentRef, {
            postId,
            authorId,
            authorEmail,
            content: trimmed,
            createdAt: new Date().toISOString(),
        });
        // lastCommentId lets the security rules verify, against the
        // post-commit state, that this counter step really corresponds to a
        // comment created by this same batch.
        // The comment is a taste signal, so its invalidation rides the same
        // batch as the comment and the counter.
        stageTasteBump(batch, authorId);
        batch.update(doc(db, "posts", postId), {
            commentsCount: increment(1),
            lastCommentId: commentRef.id,
        });
        await batch.commit();

        return true;
    } catch (error) {
        console.log("Error adding comment:", error);
        return false;
    }
};

export const deletePost = async (postId: string, uid: string): Promise<boolean> => {
    try {
        const postRef = doc(db, "posts", postId);
        const postSnap = await getDoc(postRef);

        if (!postSnap.exists()) return false;

        const postData = postSnap.data();

        // Only allow the author to delete
        if (postData.authorId !== uid) {
            console.error("Unauthorized: only the author can delete this post");
            return false;
        }

        // Delete image from Firebase Storage if it exists
        if (postData.imageUrl) {
            try {
                const storage = getStorage();
                const imageRef = ref(storage, postData.imageUrl);
                await deleteObject(imageRef);
            } catch (storageError) {
                // Storage delete can fail if file was already deleted or URL format changed
                // Continue with Firestore delete regardless
                console.warn("Storage delete failed, continuing:", storageError);
            }
        }

        // Delete associated comments BEFORE the post itself. The rules let a
        // post author remove comments on their own post, and that check reads
        // the post document — so the post has to still exist at that point.
        const commentsQuery = query(
            collection(db, "comments"),
            where("postId", "==", postId)
        );
        const commentsSnapshot = await getDocs(commentsQuery);
        await Promise.all(
            commentsSnapshot.docs.map(commentDoc => deleteDoc(commentDoc.ref))
        );

        // Delete the Firestore document
        await deleteDoc(postRef);

        console.log(`[deletePost] Post ${postId} deleted successfully`);
        return true;
    } catch (error) {
        console.error("[deletePost] Error:", error);
        return false;
    }
};

export const followUser = async (followerId: string, followingId: string): Promise<boolean> => {
    try {
        const followId = `${followerId}_${followingId}`;
        await setDoc(doc(db, 'follows', followId), {
            followerId,
            followingId,
            createdAt: new Date().toISOString(),
        });
        return true;
    } catch (error) {
        console.error('[followUser] Error:', error);
        return false;
    }
};

export const unfollowUser = async (followerId: string, followingId: string): Promise<boolean> => {
    try {
        const followId = `${followerId}_${followingId}`;
        await deleteDoc(doc(db, 'follows', followId));
        return true;
    } catch (error) {
        console.error('[unfollowUser] Error:', error);
        return false;
    }
};

export const isFollowing = async (followerId: string, followingId: string): Promise<boolean> => {
    try {
        const followId = `${followerId}_${followingId}`;
        const followSnap = await getDoc(doc(db, 'follows', followId));
        return followSnap.exists();
    } catch {
        return false;
    }
};

export const getFollowerCount = async (uid: string): Promise<number> => {
    try {
        const q = query(collection(db, 'follows'), where('followingId', '==', uid));
        const snapshot = await getDocs(q);
        return snapshot.size;
    } catch {
        return 0;
    }
};

export const getFollowingCount = async (uid: string): Promise<number> => {
    try {
        const q = query(collection(db, 'follows'), where('followerId', '==', uid));
        const snapshot = await getDocs(q);
        return snapshot.size;
    } catch {
        return 0;
    }
};

export const getFollowingIds = async (uid: string): Promise<string[]> => {
    try {
        const q = query(collection(db, 'follows'), where('followerId', '==', uid));
        const snapshot = await getDocs(q);
        return snapshot.docs.map(d => d.data().followingId);
    } catch {
        return [];
    }
};

export const savePost = async (uid: string, postId: string): Promise<boolean> => {
    try {
        // A save carries more weight than a like in the taste model, so the
        // staleness marker moves in the same batch as the save itself.
        const batch = writeBatch(db);
        batch.set(doc(db, 'saves', `${uid}_${postId}`), {
            uid,
            postId,
            createdAt: new Date().toISOString(),
        });
        stageTasteBump(batch, uid);
        await batch.commit();
        return true;
    } catch (error) {
        console.error('[savePost] Error:', error);
        return false;
    }
};

export const unsavePost = async (uid: string, postId: string): Promise<boolean> => {
    try {
        const batch = writeBatch(db);
        batch.delete(doc(db, 'saves', `${uid}_${postId}`));
        stageTasteBump(batch, uid);
        await batch.commit();
        return true;
    } catch (error) {
        console.error('[unsavePost] Error:', error);
        return false;
    }
};

export const isPostSaved = async (uid: string, postId: string): Promise<boolean> => {
    try {
        const saveId = `${uid}_${postId}`;
        const snap = await getDoc(doc(db, 'saves', saveId));
        return snap.exists();
    } catch {
        return false;
    }
};

export const getSavedPostIds = async (uid: string): Promise<string[]> => {
    try {
        const q = query(collection(db, 'saves'), where('uid', '==', uid));
        const snapshot = await getDocs(q);
        return snapshot.docs.map(d => d.data().postId);
    } catch (error) {
        console.error('[getSavedPostIds] Error:', error);
        return [];
    }
};
