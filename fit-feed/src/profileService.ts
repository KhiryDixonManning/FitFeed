import { doc, getDoc, getDocs, setDoc, collection, query, where, documentId } from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { db } from '../firebase';

// Profile data is split across two collections so that reading someone's
// display name does not also expose their account details:
//
//   users/{uid}           private  - email and account fields, owner-only
//   publicProfiles/{uid}  public   - handle, avatar; readable by signed-in users
//
// Nothing sensitive is duplicated into publicProfiles. The public handle is
// derived from the email *local part* only, which is what the UI has always
// shown; the full address (and therefore the ability to enumerate real email
// addresses) stays private.

export interface PublicProfile {
  uid: string;
  username?: string;
  displayName?: string;
  photoURL?: string;
  createdAt?: string;
}

export interface PrivateAccount {
  uid: string;
  email?: string;
  displayName?: string;
  createdAt?: string;
}

/** The part of an email before the @, used as a fallback public handle. */
export function handleFromEmail(email?: string | null): string {
  if (!email) return '';
  const local = email.split('@')[0] ?? '';
  return local.slice(0, 40);
}

export function fallbackHandle(uid: string): string {
  return `user_${uid.slice(0, 6)}`;
}

/** Resolve what to display for an author, never touching private data. */
export function displayHandle(profile: PublicProfile | undefined, uid: string): string {
  return profile?.username || profile?.displayName || fallbackHandle(uid);
}

/**
 * Keep both documents in sync for the signed-in user. Called on sign-up and
 * on every auth state change, so existing accounts gain a public profile the
 * next time they log in (the migration script covers everyone else).
 */
export async function upsertOwnProfile(user: User): Promise<void> {
  const nowIso = new Date().toISOString();

  const privateWrite = setDoc(
    doc(db, 'users', user.uid),
    {
      uid: user.uid,
      email: user.email ?? '',
      displayName: user.displayName ?? '',
      createdAt: nowIso,
    },
    { merge: true }
  );

  // Only ever non-sensitive fields here.
  const publicWrite = setDoc(
    doc(db, 'publicProfiles', user.uid),
    {
      uid: user.uid,
      displayName: handleFromEmail(user.email),
      createdAt: nowIso,
    },
    { merge: true }
  );

  await Promise.all([privateWrite, publicWrite]);
}

export async function getPublicProfile(uid: string): Promise<PublicProfile | null> {
  try {
    const snap = await getDoc(doc(db, 'publicProfiles', uid));
    return snap.exists() ? ({ uid, ...snap.data() } as PublicProfile) : null;
  } catch (error) {
    console.error('[getPublicProfile] Error:', error);
    return null;
  }
}

/**
 * Batched lookup for feed/leaderboard author names: chunks of 30 (the
 * Firestore `in` limit) instead of one read per author.
 */
export async function getPublicProfiles(uids: string[]): Promise<Record<string, PublicProfile>> {
  const unique = [...new Set(uids.filter(Boolean))];
  if (unique.length === 0) return {};

  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += 30) chunks.push(unique.slice(i, i + 30));

  const result: Record<string, PublicProfile> = {};
  try {
    const snapshots = await Promise.all(
      chunks.map(chunk =>
        getDocs(query(collection(db, 'publicProfiles'), where(documentId(), 'in', chunk)))
      )
    );
    for (const snapshot of snapshots) {
      for (const docSnap of snapshot.docs) {
        result[docSnap.id] = { uid: docSnap.id, ...docSnap.data() } as PublicProfile;
      }
    }
  } catch (error) {
    console.error('[getPublicProfiles] Error:', error);
  }
  return result;
}

/** Update the caller's own public profile fields. */
export async function updateOwnPublicProfile(
  uid: string,
  patch: Partial<Pick<PublicProfile, 'username' | 'displayName' | 'photoURL'>>
): Promise<void> {
  await setDoc(doc(db, 'publicProfiles', uid), patch, { merge: true });
}

/** The caller's own private account document (contains their email). */
export async function getOwnAccount(uid: string): Promise<PrivateAccount | null> {
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    return snap.exists() ? ({ uid, ...snap.data() } as PrivateAccount) : null;
  } catch (error) {
    console.error('[getOwnAccount] Error:', error);
    return null;
  }
}
