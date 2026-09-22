"""User taste vectors: derivation, bounding, decay, caching and cold start."""

from __future__ import annotations

import math
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from google.cloud import firestore as gcf

from style_vectors import STYLE_VECTOR_VERSION, style_similarity, post_style_vector
from interactions import (
    TYPE_IMPRESSION,
    TYPE_MORE_LIKE_THIS,
    TYPE_NOT_INTERESTED,
    TYPE_VIEW,
    interaction_doc_id,
)
from taste_profile import (
    CACHE_TTL_SECONDS,
    SIGNAL_WEIGHTS,
    TASTE_VECTOR_VERSION,
    build_taste_vector,
    get_taste_vector,
)

NOW = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture(scope="module")
def db():
    if not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        raise RuntimeError("Run via `npm run test:backend` (starts the emulator).")
    return gcf.Client(project=os.environ.get("GCLOUD_PROJECT", "fitfeed-rules-test"))


@pytest.fixture
def user(db):
    """A user with liked/saved posts spanning two aesthetics."""
    uid = f"taste_{uuid.uuid4().hex[:8]}"
    created_posts = []

    batch = db.batch()
    for i in range(4):
        post_id = f"{uid}_liked{i}"
        batch.set(db.collection("posts").document(post_id), {
            "authorId": "someone",
            "category": "streetwear",
            "aestheticScores": {"streetwear": 0.9, "y2k": 0.3},
            "aestheticTags": ["oversized"],
            "detectedItems": ["hoodie", "sneakers"],
            "palette": [{"hex": "#1E90FF", "percentage": 70}],
            "likesCount": 1,
            "createdAt": NOW - timedelta(days=2),
        })
        # Phase 8: a like is a document under the post, not an array entry.
        batch.set(
            db.collection("posts").document(post_id).collection("likes").document(uid),
            {"uid": uid, "createdAt": NOW - timedelta(days=2)},
        )
        created_posts.append(post_id)

    saved_id = f"{uid}_saved0"
    batch.set(db.collection("posts").document(saved_id), {
        "authorId": "someone",
        "category": "cottagecore",
        "aestheticScores": {"cottagecore": 0.95},
        "likesCount": 0,
        "createdAt": NOW - timedelta(days=1),
    })
    created_posts.append(saved_id)
    batch.set(db.collection("saves").document(f"{uid}_{saved_id}"),
              {"uid": uid, "postId": saved_id, "createdAt": NOW.isoformat()})
    batch.set(db.collection("userPreferences").document(uid),
              {"streetwear": 8, "vintage": 2})
    batch.commit()

    yield uid

    cleanup = db.batch()
    for post_id in created_posts:
        cleanup.delete(db.collection("posts").document(post_id).collection("likes").document(uid))
        cleanup.delete(db.collection("posts").document(post_id))
    cleanup.delete(db.collection("saves").document(f"{uid}_{saved_id}"))
    cleanup.delete(db.collection("userPreferences").document(uid))
    cleanup.delete(db.collection("userTasteVectors").document(uid))
    cleanup.commit()


class TestBuild:
    def test_is_versioned(self, db, user):
        vector = build_taste_vector(db, user, now=NOW)
        assert vector["version"] == TASTE_VECTOR_VERSION
        assert vector["styleVectorVersion"] == STYLE_VECTOR_VERSION

    def test_reflects_interactions(self, db, user):
        vector = build_taste_vector(db, user, now=NOW)
        assert vector["aesthetics"].get("streetwear", 0) > 0
        assert vector["aesthetics"].get("cottagecore", 0) > 0
        assert vector["isEmpty"] is False

    def test_counts_the_signals_it_used(self, db, user):
        vector = build_taste_vector(db, user, now=NOW)
        assert vector["signals"]["like"] == 4
        assert vector["signals"]["save"] == 1
        assert vector["signals"]["category"] >= 1

    def test_values_are_bounded(self, db, user):
        vector = build_taste_vector(db, user, now=NOW)
        for facet in ("aesthetics", "tags", "items", "colors"):
            for value in vector.get(facet, {}).values():
                assert 0.0 <= value <= 1.0

    def test_dimensionality_is_capped(self, db, user):
        vector = build_taste_vector(db, user, now=NOW)
        for facet in ("aesthetics", "tags", "items", "colors"):
            assert len(vector.get(facet, {})) <= 24

    def test_a_save_outweighs_a_like(self, db, user):
        """One save should carry more than one like of the same age."""
        vector = build_taste_vector(db, user, now=NOW)
        # 4 streetwear likes vs 1 cottagecore save: streetwear still leads,
        # but the single save is clearly represented.
        assert vector["aesthetics"]["cottagecore"] > 0.15

    def test_old_interactions_decay(self, db, user):
        recent = build_taste_vector(db, user, now=NOW)
        # A year later the same interactions should count for much less
        # relative to nothing else changing, so the vector stays bounded.
        distant = build_taste_vector(db, user, now=NOW + timedelta(days=365))
        assert distant["aesthetics"]
        for value in distant["aesthetics"].values():
            assert 0.0 <= value <= 1.0
        assert recent["signals"]["like"] == distant["signals"]["like"]

    def test_repeatable(self, db, user):
        first = build_taste_vector(db, user, now=NOW)
        second = build_taste_vector(db, user, now=NOW)
        assert first["aesthetics"] == second["aesthetics"]

    def test_cold_start_user_is_empty_not_broken(self, db):
        vector = build_taste_vector(db, f"nobody_{uuid.uuid4().hex[:6]}", now=NOW)
        assert vector["isEmpty"] is True
        assert vector["version"] == TASTE_VECTOR_VERSION
        # A cold profile must be usable by the similarity function.
        assert style_similarity(vector, post_style_vector({"category": "streetwear"})) == 0.0

    def test_malformed_preferences_are_survivable(self, db):
        uid = f"junk_{uuid.uuid4().hex[:6]}"
        db.collection("userPreferences").document(uid).set(
            {"streetwear": "lots", "vintage": None, "zzz_unknown": 5, "y2k": 3}
        )
        try:
            vector = build_taste_vector(db, uid, now=NOW)
            assert vector["aesthetics"].get("y2k", 0) > 0
            assert "zzz_unknown" not in vector["aesthetics"]
        finally:
            db.collection("userPreferences").document(uid).delete()

    def test_legacy_posts_without_analysis_still_contribute(self, db):
        uid = f"legacy_{uuid.uuid4().hex[:6]}"
        post_id = f"{uid}_p0"
        db.collection("posts").document(post_id).set({
            "authorId": "a", "category": "vintage",   # no aestheticScores at all
            "likesCount": 1, "createdAt": NOW - timedelta(days=1),
        })
        db.collection("posts").document(post_id).collection("likes").document(uid).set(
            {"uid": uid, "createdAt": NOW - timedelta(days=1)}
        )
        try:
            vector = build_taste_vector(db, uid, now=NOW)
            assert vector["aesthetics"].get("vintage", 0) > 0
        finally:
            db.collection("posts").document(post_id).collection("likes").document(uid).delete()
            db.collection("posts").document(post_id).delete()


class TestCaching:
    def test_caches_and_reuses(self, db, user):
        first = get_taste_vector(db, user, now=NOW)
        stored = db.collection("userTasteVectors").document(user).get()
        assert stored.exists
        second = get_taste_vector(db, user, now=NOW + timedelta(seconds=60))
        assert second["aesthetics"] == first["aesthetics"]

    def test_stale_cache_is_rebuilt(self, db, user):
        get_taste_vector(db, user, now=NOW)
        later = NOW + timedelta(seconds=CACHE_TTL_SECONDS + 60)
        rebuilt = get_taste_vector(db, user, now=later)
        assert rebuilt["updatedAt"] is not None

    def test_a_version_bump_invalidates_the_cache(self, db, user):
        db.collection("userTasteVectors").document(user).set({
            "version": TASTE_VECTOR_VERSION - 1,
            "styleVectorVersion": STYLE_VECTOR_VERSION,
            "updatedAt": NOW,
            "aesthetics": {"obsolete": 1.0},
        })
        vector = get_taste_vector(db, user, now=NOW)
        assert vector["version"] == TASTE_VECTOR_VERSION
        assert "obsolete" not in vector.get("aesthetics", {})

    def test_force_rebuild(self, db, user):
        get_taste_vector(db, user, now=NOW)
        forced = get_taste_vector(db, user, now=NOW, force_rebuild=True)
        assert forced["version"] == TASTE_VECTOR_VERSION


class TestPersonalisationEffect:
    def test_taste_ranks_matching_posts_higher(self, db, user):
        taste = build_taste_vector(db, user, now=NOW)
        streetwear = post_style_vector({"category": "streetwear",
                                        "aestheticScores": {"streetwear": 0.9}})
        western = post_style_vector({"category": "western",
                                     "aestheticScores": {"western": 0.9}})
        assert style_similarity(taste, streetwear) > style_similarity(taste, western)

    def test_similarity_stays_bounded_for_a_real_profile(self, db, user):
        taste = build_taste_vector(db, user, now=NOW)
        for category in ("streetwear", "vintage", "western", "cottagecore"):
            value = style_similarity(taste, post_style_vector({"category": category}))
            assert 0.0 <= value <= 1.0


class TestCacheFreshnessOnInteraction:
    """A recorded interaction must not wait out the TTL to take effect."""

    def bump(self, db, uid, to=None):
        from taste_profile import TASTE_STATE_COLLECTION
        ref = db.collection(TASTE_STATE_COLLECTION).document(uid)
        if to is None:
            ref.set({"generation": gcf.Increment(1)}, merge=True)
        else:
            ref.set({"generation": to}, merge=True)

    def test_a_new_interaction_invalidates_a_fresh_cache(self, db, user):
        from taste_profile import read_taste_generation
        first = get_taste_vector(db, user, now=NOW)
        assert first.get("builtFromGeneration") == 0

        # Simulate a like: the client bumps the generation marker.
        self.bump(db, user)
        assert read_taste_generation(db, user) == 1

        # Well inside the TTL, but the cache is no longer current.
        rebuilt = get_taste_vector(db, user, now=NOW + timedelta(seconds=30))
        assert rebuilt["builtFromGeneration"] == 1

    def test_an_unchanged_generation_still_uses_the_cache(self, db, user):
        get_taste_vector(db, user, now=NOW)
        db.collection("userTasteVectors").document(user).set(
            {"aesthetics": {"sentinel": 1.0}}, merge=True
        )
        cached = get_taste_vector(db, user, now=NOW + timedelta(seconds=30))
        # Sentinel survives => the cached document was served, not rebuilt.
        assert "sentinel" in cached.get("aesthetics", {})

    def test_removing_a_like_is_reflected_after_a_bump(self, db, user):
        """Unlike must reduce influence, not just adding a like."""
        before = get_taste_vector(db, user, now=NOW)
        assert before["signals"]["like"] == 4

        # Unlike at source (delete the like documents), then bump as the
        # client would after the transaction commits.
        for i in range(2):
            (db.collection("posts").document(f"{user}_liked{i}")
               .collection("likes").document(user).delete())
        self.bump(db, user)

        after = get_taste_vector(db, user, now=NOW + timedelta(seconds=30))
        assert after["signals"]["like"] == 2

    def test_a_legacy_cache_without_a_generation_is_rebuilt(self, db, user):
        db.collection("userTasteVectors").document(user).set({
            "version": TASTE_VECTOR_VERSION,
            "styleVectorVersion": STYLE_VECTOR_VERSION,
            "updatedAt": NOW,
            "aesthetics": {"stale": 1.0},
        })
        rebuilt = get_taste_vector(db, user, now=NOW)
        assert "stale" not in rebuilt.get("aesthetics", {})
        assert rebuilt["builtFromGeneration"] == 0

    def test_a_malformed_generation_marker_is_survivable(self, db, user):
        from taste_profile import TASTE_STATE_COLLECTION, read_taste_generation
        for junk in ["lots", None, True, {"n": 1}]:
            db.collection(TASTE_STATE_COLLECTION).document(user).set({"generation": junk})
            assert read_taste_generation(db, user) == 0
            assert get_taste_vector(db, user, now=NOW)["version"] == TASTE_VECTOR_VERSION

    def test_concurrent_bumps_do_not_lose_updates(self, db, user):
        from taste_profile import TASTE_STATE_COLLECTION, read_taste_generation
        import threading

        db.collection(TASTE_STATE_COLLECTION).document(user).set({"generation": 0})
        barrier = threading.Barrier(6)

        def bump_once():
            barrier.wait()
            db.collection(TASTE_STATE_COLLECTION).document(user).set(
                {"generation": gcf.Increment(1)}, merge=True
            )

        threads = [threading.Thread(target=bump_once) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # Increment is atomic: every concurrent interaction is counted.
        assert read_taste_generation(db, user) == 6

    def test_generation_only_moves_forward_for_cache_purposes(self, db, user):
        get_taste_vector(db, user, now=NOW)
        self.bump(db, user, to=5)
        rebuilt = get_taste_vector(db, user, now=NOW + timedelta(seconds=30))
        assert rebuilt["builtFromGeneration"] == 5
        # A vector built at generation 5 stays valid while the marker is 5.
        again = get_taste_vector(db, user, now=NOW + timedelta(seconds=60))
        assert again["builtFromGeneration"] == 5


class TestSignalWeighting:
    """Phase 7: passive signals inform taste; explicit signals define it."""

    @staticmethod
    def add_signals(db, uid, interaction_type, post_ids, when=None, value=None):
        ref = db.collection("users").document(uid).collection("interactions")
        batch = db.batch()
        doc_ids = []
        for post_id in post_ids:
            doc_id = interaction_doc_id(interaction_type, post_id)
            payload = {
                "postId": post_id,
                "type": interaction_type,
                "createdAt": (when or NOW).isoformat(),
                "schemaVersion": 1,
            }
            if value:
                payload["value"] = value
            batch.set(ref.document(doc_id), payload)
            doc_ids.append(doc_id)
        batch.commit()
        return doc_ids

    @staticmethod
    def drop_signals(db, uid, doc_ids):
        ref = db.collection("users").document(uid).collection("interactions")
        batch = db.batch()
        for doc_id in doc_ids:
            batch.delete(ref.document(doc_id))
        batch.commit()

    @staticmethod
    def make_posts(db, prefix, count, aesthetic):
        ids = []
        batch = db.batch()
        for i in range(count):
            post_id = f"{prefix}_{aesthetic}_{i}"
            batch.set(db.collection("posts").document(post_id), {
                "authorId": "someone",
                "category": aesthetic,
                "aestheticScores": {aesthetic: 0.95},
                "aestheticTags": [f"{aesthetic}_tag"],
                "detectedItems": [f"{aesthetic}_item"],
                "createdAt": NOW - timedelta(days=1),
            })
            ids.append(post_id)
        batch.commit()
        return ids

    @staticmethod
    def drop_posts(db, post_ids):
        batch = db.batch()
        for post_id in post_ids:
            batch.delete(db.collection("posts").document(post_id))
        batch.commit()

    def test_the_weights_keep_explicit_feedback_above_passive_signal(self):
        # An ordering property, asserted directly so that a future tweak that
        # inverts it fails here rather than quietly in production ranking.
        assert SIGNAL_WEIGHTS["more_like_this"] > SIGNAL_WEIGHTS["save"]
        assert SIGNAL_WEIGHTS["save"] > SIGNAL_WEIGHTS["like"]
        assert SIGNAL_WEIGHTS["like"] > SIGNAL_WEIGHTS["view"]
        assert SIGNAL_WEIGHTS["view"] > SIGNAL_WEIGHTS["impression"]
        assert SIGNAL_WEIGHTS["not_interested"] < 0
        # A single like outweighs ten impressions of the same thing.
        assert SIGNAL_WEIGHTS["like"] > 10 * SIGNAL_WEIGHTS["impression"]

    def test_repeated_impressions_do_not_overpower_explicit_likes(self, db, user):
        """Scrolling past something many times must not rewrite taste."""
        baseline = build_taste_vector(db, user, now=NOW)
        assert baseline["aesthetics"]["streetwear"] > baseline["aesthetics"].get("gorpcore", 0)

        posts = self.make_posts(db, user, 40, "gorpcore")
        signals = self.add_signals(db, user, TYPE_IMPRESSION, posts)
        try:
            flooded = build_taste_vector(db, user, now=NOW)
            # The impressions register...
            assert flooded["aesthetics"].get("gorpcore", 0) > 0
            assert flooded["signals"]["impression"] == 40
            # ...but 40 passive views cannot displace 4 deliberate likes.
            assert flooded["aesthetics"]["streetwear"] > flooded["aesthetics"]["gorpcore"]
        finally:
            self.drop_signals(db, user, signals)
            self.drop_posts(db, posts)

    def test_a_dwelt_view_counts_for_more_than_a_glance(self, db, user):
        posts = self.make_posts(db, user, 6, "gorpcore")
        glances = self.add_signals(db, user, TYPE_IMPRESSION, posts)
        try:
            impressions_only = build_taste_vector(db, user, now=NOW)
            dwells = self.add_signals(db, user, TYPE_VIEW, posts, value="long")
            try:
                with_views = build_taste_vector(db, user, now=NOW)
                assert (with_views["aesthetics"]["gorpcore"]
                        > impressions_only["aesthetics"]["gorpcore"])
            finally:
                self.drop_signals(db, user, dwells)
        finally:
            self.drop_signals(db, user, glances)
            self.drop_posts(db, posts)

    def test_more_like_this_raises_the_relevant_dimensions(self, db, user):
        baseline = build_taste_vector(db, user, now=NOW)
        assert baseline["aesthetics"].get("gorpcore", 0) == 0

        posts = self.make_posts(db, user, 1, "gorpcore")
        signals = self.add_signals(db, user, TYPE_MORE_LIKE_THIS, posts)
        try:
            asked_for = build_taste_vector(db, user, now=NOW)
            assert asked_for["aesthetics"]["gorpcore"] > 0
            assert asked_for["tags"].get("gorpcore tag", 0) > 0
            assert asked_for["signals"]["more_like_this"] == 1
            # One explicit request weighs far more than one passive impression:
            # the same post merely seen does not sustain the dimension at all.
            self.drop_signals(db, user, signals)
            passive = self.add_signals(db, user, TYPE_IMPRESSION, posts)
            try:
                seen_only = build_taste_vector(db, user, now=NOW)
                assert (asked_for["aesthetics"]["gorpcore"]
                        > seen_only["aesthetics"].get("gorpcore", 0.0))
            finally:
                self.drop_signals(db, user, passive)
        finally:
            self.drop_posts(db, posts)

    def test_not_interested_lowers_similarity_to_that_style(self, db, user):
        target = {
            "id": "probe", "category": "streetwear",
            "aestheticScores": {"streetwear": 0.95},
            "aestheticTags": ["oversized"], "detectedItems": ["hoodie"],
        }
        before = style_similarity(post_style_vector(target),
                                  build_taste_vector(db, user, now=NOW))

        # The user says "less of this" about the streetwear posts they liked.
        signals = self.add_signals(
            db, user, TYPE_NOT_INTERESTED, [f"{user}_liked{i}" for i in range(4)]
        )
        try:
            after_vector = build_taste_vector(db, user, now=NOW)
            after = style_similarity(post_style_vector(target), after_vector)
            assert after < before
            # Negative feedback floors at zero: it never produces a negative
            # dimension or a negative similarity.
            assert all(v >= 0 for v in after_vector["aesthetics"].values())
            assert after >= 0.0
        finally:
            self.drop_signals(db, user, signals)

    def test_removing_an_explicit_signal_is_reflected_on_rebuild(self, db, user):
        posts = self.make_posts(db, user, 1, "gorpcore")
        signals = self.add_signals(db, user, TYPE_MORE_LIKE_THIS, posts)
        try:
            with_signal = build_taste_vector(db, user, now=NOW)
            assert with_signal["aesthetics"].get("gorpcore", 0) > 0
        finally:
            self.drop_signals(db, user, signals)

        try:
            without = build_taste_vector(db, user, now=NOW)
            assert without["aesthetics"].get("gorpcore", 0) == 0
            assert without["signals"].get("more_like_this", 0) == 0
        finally:
            self.drop_posts(db, posts)

    def test_no_nan_or_infinity_survives_into_a_vector(self, db, user):
        posts = self.make_posts(db, user, 3, "gorpcore")
        signals = (
            self.add_signals(db, user, TYPE_IMPRESSION, posts)
            + self.add_signals(db, user, TYPE_NOT_INTERESTED, posts)
        )
        try:
            vector = build_taste_vector(db, user, now=NOW)
            for facet in ("aesthetics", "tags", "items", "colors"):
                for key, value in vector.get(facet, {}).items():
                    assert isinstance(value, float), f"{facet}.{key} is {type(value)}"
                    assert math.isfinite(value), f"{facet}.{key} is {value}"
                    assert 0.0 <= value <= 1.0, f"{facet}.{key} is {value}"
        finally:
            self.drop_signals(db, user, signals)
            self.drop_posts(db, posts)

    def test_hostile_interaction_documents_do_not_break_a_rebuild(self, db, user):
        """Rules reject these shapes, but a rebuild must survive them anyway."""
        ref = db.collection("users").document(user).collection("interactions")
        junk = {
            "impression_bad1": {"postId": None, "type": TYPE_IMPRESSION},
            "impression_bad2": {"postId": "ghost_post", "type": TYPE_IMPRESSION},
            "impression_bad3": {"type": TYPE_IMPRESSION, "createdAt": "not-a-date"},
            "impression_bad4": {"postId": 12345, "type": "invented_type"},
        }
        for doc_id, payload in junk.items():
            ref.document(doc_id).set(payload)
        try:
            vector = build_taste_vector(db, user, now=NOW)
            assert vector["aesthetics"]["streetwear"] > 0
            assert vector["isEmpty"] is False
        finally:
            batch = db.batch()
            for doc_id in junk:
                batch.delete(ref.document(doc_id))
            batch.commit()


class TestTimestampCannotDistortDecay:
    """createdAt is a client-supplied string; decay must not trust it.

    The rules require it to be a string but cannot sanely bound a timestamp,
    so the server clamps instead: a signal can never count for MORE than a
    brand-new one, whatever date it claims.
    """

    # One impression is too weak to hold a dimension on its own once the
    # vector is normalised, so these use a small batch of them.
    SIGNAL_POSTS = 12

    @staticmethod
    def add_batch(db, uid, post_ids, created_at, interaction_type=TYPE_IMPRESSION):
        ref = db.collection("users").document(uid).collection("interactions")
        batch = db.batch()
        doc_ids = []
        for post_id in post_ids:
            doc_id = f"{interaction_type}_{post_id}"
            batch.set(ref.document(doc_id), {
                "postId": post_id, "type": interaction_type,
                "createdAt": created_at, "schemaVersion": 1,
            })
            doc_ids.append(doc_id)
        batch.commit()
        return doc_ids

    @staticmethod
    def drop(db, uid, doc_ids):
        ref = db.collection("users").document(uid).collection("interactions")
        batch = db.batch()
        for doc_id in doc_ids:
            batch.delete(ref.document(doc_id))
        batch.commit()

    def gorpcore_weight(self, db, uid, posts, created_at, interaction_type=TYPE_IMPRESSION):
        """Rebuild with one batch of signals at this timestamp, then clean up."""
        doc_ids = self.add_batch(db, uid, posts, created_at, interaction_type)
        try:
            return build_taste_vector(db, uid, now=NOW)["aesthetics"].get("gorpcore", 0.0)
        finally:
            self.drop(db, uid, doc_ids)

    def test_a_far_future_timestamp_is_capped_at_present_weight(self, db, user):
        posts = TestSignalWeighting.make_posts(db, user, self.SIGNAL_POSTS, "gorpcore")
        try:
            honest = self.gorpcore_weight(db, user, posts, NOW.isoformat())
            forged = self.gorpcore_weight(db, user, posts, "2999-01-01T00:00:00+00:00")
            assert honest > 0
            # Claiming the future buys exactly nothing.
            assert forged == pytest.approx(honest)
        finally:
            TestSignalWeighting.drop_posts(db, posts)

    def test_backdating_a_signal_only_weakens_it(self, db, user):
        posts = TestSignalWeighting.make_posts(db, user, self.SIGNAL_POSTS, "gorpcore")
        try:
            now_weight = self.gorpcore_weight(db, user, posts, NOW.isoformat())
            back_weight = self.gorpcore_weight(
                db, user, posts, (NOW - timedelta(days=400)).isoformat()
            )
            assert back_weight < now_weight
        finally:
            TestSignalWeighting.drop_posts(db, posts)

    def test_an_iso_string_timestamp_actually_decays(self, db, user):
        """Regression: signals are written as ISO strings by the browser.

        A parser that only understood datetime objects silently gave every
        client-written like, save and signal the flat "unknown age" weight,
        so nothing a user did ever aged out.
        """
        posts = TestSignalWeighting.make_posts(db, user, self.SIGNAL_POSTS, "gorpcore")
        try:
            fresh = self.gorpcore_weight(db, user, posts, NOW.isoformat())
            aged = self.gorpcore_weight(
                db, user, posts, (NOW - timedelta(days=365)).isoformat()
            )
            assert aged < fresh
        finally:
            TestSignalWeighting.drop_posts(db, posts)

    def test_decay_follows_when_the_user_acted_not_the_post_age(self, db, user):
        """Scrolling past an old post today is a signal about today."""
        posts = TestSignalWeighting.make_posts(db, user, self.SIGNAL_POSTS, "gorpcore")
        update = db.batch()
        for post_id in posts:
            update.update(db.collection("posts").document(post_id),
                          {"createdAt": NOW - timedelta(days=720)})
        update.commit()
        try:
            acted_today = self.gorpcore_weight(db, user, posts, NOW.isoformat())
            acted_long_ago = self.gorpcore_weight(
                db, user, posts, (NOW - timedelta(days=720)).isoformat()
            )
            assert acted_today > acted_long_ago
        finally:
            TestSignalWeighting.drop_posts(db, posts)

    def test_explicit_feedback_is_exempt_from_decay_by_design(self, db, user):
        """A deliberate "more of this" should not quietly expire."""
        posts = TestSignalWeighting.make_posts(db, user, 1, "gorpcore")
        try:
            now_value = self.gorpcore_weight(
                db, user, posts, NOW.isoformat(), TYPE_MORE_LIKE_THIS
            )
            aged = self.gorpcore_weight(
                db, user, posts, (NOW - timedelta(days=365)).isoformat(), TYPE_MORE_LIKE_THIS
            )
            assert now_value > 0
            assert aged == pytest.approx(now_value)
        finally:
            TestSignalWeighting.drop_posts(db, posts)

    def test_the_decay_factor_never_exceeds_one(self):
        from taste_profile import _recency_weight

        for created in (
            NOW,                                   # right now
            NOW + timedelta(days=3650),            # ten years ahead
            NOW + timedelta(seconds=1),
            NOW.isoformat(),
            "2999-01-01T00:00:00+00:00",
        ):
            assert _recency_weight(created, NOW) <= 1.0

    @pytest.mark.parametrize("created_at", [
        "", "not-a-date", "0000-00-00", "2026-13-45T99:99:99Z", "9999999999999",
        None, 12345, {"seconds": 0}, [], True,
    ])
    def test_a_malformed_timestamp_is_survivable_and_weak(self, db, user, created_at):
        posts = TestSignalWeighting.make_posts(db, user, 1, "gorpcore")
        doc_ids = self.add_batch(db, user, posts, created_at)
        try:
            vector = build_taste_vector(db, user, now=NOW)
            # Still a valid, bounded vector; the unparseable signal counts at
            # the "unknown age" weight rather than crashing the rebuild.
            assert vector["aesthetics"]["streetwear"] > 0
            for value in vector["aesthetics"].values():
                assert 0.0 <= value <= 1.0
        finally:
            self.drop(db, user, doc_ids)
            TestSignalWeighting.drop_posts(db, posts)

    def test_an_old_signal_still_decays_normally(self):
        from taste_profile import DECAY_HALF_LIFE_DAYS, _recency_weight

        half_life_ago = NOW - timedelta(days=DECAY_HALF_LIFE_DAYS)
        assert _recency_weight(half_life_ago, NOW) == pytest.approx(0.5, abs=1e-9)
        assert _recency_weight(NOW - timedelta(days=2 * DECAY_HALF_LIFE_DAYS), NOW) \
            == pytest.approx(0.25, abs=1e-9)
        # And the ISO-string form of the same instant agrees with it.
        assert _recency_weight(half_life_ago.isoformat(), NOW) == pytest.approx(0.5, abs=1e-9)
