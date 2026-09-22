"""Candidate retrieval, cursors and the /feed contract (Firestore emulator)."""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from google.cloud import firestore as gcf

import app as app_module
import auth as auth_module
import rate_limit
from feed_cursor import CursorError, decode_cursor, encode_cursor
from feed_service import (
    MODE_DISCOVER,
    MODE_FOLLOWING,
    MODE_FOR_YOU,
    build_for_you_page,
    fetch_discover,
    fetch_following,
    fetch_for_you_candidates,
    get_following_ids,
    serialize_post,
)

VIEWER = "viewer_uid"
NOW = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture(scope="module")
def db():
    if not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        raise RuntimeError("Run via `npm run test:backend` (starts the emulator).")
    return gcf.Client(project=os.environ.get("GCLOUD_PROJECT", "fitfeed-rules-test"))


@pytest.fixture
def seeded(db):
    """40 posts across 3 authors and 2 categories, newest first."""
    prefix = uuid.uuid4().hex[:8]
    created = []
    batch = db.batch()
    for i in range(40):
        post_id = f"{prefix}_p{i:02d}"
        batch.set(db.collection("posts").document(post_id), {
            "authorId": f"{prefix}_author{i % 3}",
            "content": f"post {i}",
            "imageUrl": "https://firebasestorage.googleapis.com/v0/b/b/o/posts%2Fx%2F1.jpg",
            "category": "streetwear" if i % 2 == 0 else "vintage",
            "likesCount": i,
            "commentsCount": i % 5,
            "likedBy": [VIEWER] if i % 4 == 0 else [],
            # Newest first: p00 is the most recent.
            "createdAt": NOW - timedelta(hours=i),
        })
        created.append(post_id)
    batch.commit()

    yield {"prefix": prefix, "ids": created}

    for chunk_start in range(0, len(created), 400):
        cleanup = db.batch()
        for post_id in created[chunk_start:chunk_start + 400]:
            cleanup.delete(db.collection("posts").document(post_id))
        cleanup.commit()


def ids_of(page):
    return [p["id"] for p in page.posts]


class TestSerialization:
    def test_omits_the_unbounded_likedby_array(self):
        out = serialize_post("p1", {"likedBy": ["a"] * 5000, "likesCount": 5000}, VIEWER)
        assert "likedBy" not in out
        assert out["likesCount"] == 5000

    def test_computes_liked_by_me(self):
        # The legacy array is never a source of truth: attach_liked_by_me
        # resolves like state from the subcollection. Seeding from the array
        # would make an unlike un-observable, because no client can clean it.
        assert serialize_post("p1", {"likedBy": [VIEWER]}, VIEWER)["likedByMe"] is False
        assert serialize_post("p1", {"likedBy": ["someone"]}, VIEWER)["likedByMe"] is False
        assert serialize_post("p1", {}, VIEWER)["likedByMe"] is False

    def test_counts_are_coerced(self):
        out = serialize_post("p1", {"likesCount": None, "commentsCount": "x"}, VIEWER)
        assert out["likesCount"] == 0 and out["commentsCount"] == 0

    def test_createdAt_is_iso(self):
        out = serialize_post("p1", {"createdAt": NOW}, VIEWER)
        assert out["createdAt"].startswith("2026-06-01")


class TestCursors:
    def test_round_trip(self):
        token = encode_cursor(NOW, "post1", MODE_DISCOVER, None)
        parsed = decode_cursor(token, MODE_DISCOVER, None)
        assert parsed.post_id == "post1"
        assert parsed.created_at == NOW

    def test_is_opaque(self):
        token = encode_cursor(NOW, "post1", MODE_DISCOVER, None)
        assert "post1" not in token

    def test_rejects_garbage(self):
        for bad in ["", "!!!!", "a" * 600, None, 42, "eyJ1bmZpbmlzaGVk"]:
            with pytest.raises(CursorError):
                decode_cursor(bad, MODE_DISCOVER, None)

    def test_rejects_a_cursor_from_another_mode(self):
        token = encode_cursor(NOW, "p1", MODE_DISCOVER, None)
        with pytest.raises(CursorError):
            decode_cursor(token, MODE_FOLLOWING, None)

    def test_rejects_a_cursor_from_another_category(self):
        token = encode_cursor(NOW, "p1", MODE_DISCOVER, "streetwear")
        with pytest.raises(CursorError):
            decode_cursor(token, MODE_DISCOVER, "vintage")

    def test_rejects_out_of_range_timestamps(self):
        import base64, json
        payload = {"v": 1, "t": 99_999_999_999_999, "i": "p1", "m": MODE_DISCOVER, "c": ""}
        token = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
        with pytest.raises(CursorError):
            decode_cursor(token, MODE_DISCOVER, None)

    def test_rejects_path_traversal_in_the_document_id(self):
        import base64, json
        payload = {"v": 1, "t": 1000, "i": "../../admin", "m": MODE_DISCOVER, "c": ""}
        token = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
        with pytest.raises(CursorError):
            decode_cursor(token, MODE_DISCOVER, None)

    def test_rejects_an_unsupported_version(self):
        import base64, json
        payload = {"v": 99, "t": 1000, "i": "p1", "m": MODE_DISCOVER, "c": ""}
        token = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
        with pytest.raises(CursorError):
            decode_cursor(token, MODE_DISCOVER, None)


class TestDiscover:
    def test_returns_a_bounded_page(self, db, seeded):
        page = fetch_discover(db, VIEWER, 10, None, None)
        assert len(page.posts) == 10
        assert page.has_more and page.next_cursor
        assert page.queries_issued == 1

    def test_is_newest_first(self, db, seeded):
        page = fetch_discover(db, VIEWER, 10, None, None)
        stamps = [p["createdAt"] for p in page.posts]
        assert stamps == sorted(stamps, reverse=True)

    def test_pagination_has_no_duplicates_and_is_stable(self, db, seeded):
        first = fetch_discover(db, VIEWER, 10, None, None)
        cursor = decode_cursor(first.next_cursor, MODE_DISCOVER, None)
        second = fetch_discover(db, VIEWER, 10, None, cursor)

        assert not (set(ids_of(first)) & set(ids_of(second)))
        # Second page continues strictly older.
        assert min(p["createdAt"] for p in first.posts) > max(p["createdAt"] for p in second.posts)

        # Re-requesting the same cursor gives the same page.
        again = fetch_discover(db, VIEWER, 10, None, cursor)
        assert ids_of(second) == ids_of(again)

    def test_walking_every_page_yields_each_post_once(self, db, seeded):
        seen, cursor, guard = [], None, 0
        while guard < 20:
            guard += 1
            page = fetch_discover(db, VIEWER, 7, None, cursor)
            seen.extend(ids_of(page))
            if not page.next_cursor:
                break
            cursor = decode_cursor(page.next_cursor, MODE_DISCOVER, None)
        mine = [i for i in seen if i.startswith(seeded["prefix"])]
        assert len(mine) == len(set(mine)) == 40

    def test_category_filter(self, db, seeded):
        page = fetch_discover(db, VIEWER, 10, "vintage", None)
        assert page.posts
        assert all(p["category"] == "vintage" for p in page.posts)

    def test_last_page_reports_no_more(self, db, seeded):
        page = fetch_discover(db, VIEWER, 500, None, None)
        assert page.has_more is False
        assert page.next_cursor is None


class TestFollowing:
    def test_empty_following_list_returns_nothing(self, db, seeded):
        page = fetch_following(db, VIEWER, 10, None, None, [])
        assert page.posts == [] and page.has_more is False

    def test_only_followed_authors_appear(self, db, seeded):
        author = f"{seeded['prefix']}_author1"
        page = fetch_following(db, VIEWER, 20, None, None, [author])
        assert page.posts
        assert all(p["authorId"] == author for p in page.posts)

    def test_chunks_beyond_the_in_limit(self, db, seeded):
        # 25 authors > Firestore's 10-value `in` cap, so this must chunk.
        authors = [f"{seeded['prefix']}_author{i % 3}" for i in range(3)]
        authors += [f"unused_{i}" for i in range(22)]
        page = fetch_following(db, VIEWER, 10, None, None, authors)
        assert page.queries_issued >= 3
        assert len(page.posts) == 10

    def test_merged_results_stay_ordered(self, db, seeded):
        authors = [f"{seeded['prefix']}_author{i}" for i in range(3)]
        page = fetch_following(db, VIEWER, 20, None, None, authors)
        stamps = [p["createdAt"] for p in page.posts]
        assert stamps == sorted(stamps, reverse=True)

    def test_pagination_has_no_duplicates(self, db, seeded):
        authors = [f"{seeded['prefix']}_author{i}" for i in range(3)]
        first = fetch_following(db, VIEWER, 10, None, None, authors)
        cursor = decode_cursor(first.next_cursor, MODE_FOLLOWING, None)
        second = fetch_following(db, VIEWER, 10, None, cursor, authors)
        assert not (set(ids_of(first)) & set(ids_of(second)))

    def test_category_filter_applies(self, db, seeded):
        authors = [f"{seeded['prefix']}_author{i}" for i in range(3)]
        page = fetch_following(db, VIEWER, 20, "vintage", None, authors)
        assert all(p["category"] == "vintage" for p in page.posts)

    def test_get_following_ids_is_bounded(self, db):
        uid = f"follower_{uuid.uuid4().hex[:6]}"
        batch = db.batch()
        for i in range(5):
            batch.set(db.collection("follows").document(f"{uid}_target{i}"),
                      {"followerId": uid, "followingId": f"target{i}"})
        batch.commit()
        try:
            ids = get_following_ids(db, uid)
            assert len(ids) == 5
        finally:
            cleanup = db.batch()
            for i in range(5):
                cleanup.delete(db.collection("follows").document(f"{uid}_target{i}"))
            cleanup.commit()


class TestForYou:
    def test_candidate_window_is_bounded(self, db, seeded):
        candidates = fetch_for_you_candidates(db, VIEWER, None, None, window=15)
        assert len(candidates) <= 16  # window + 1 lookahead

    def test_window_never_exceeds_the_hard_cap(self, db, seeded):
        candidates = fetch_for_you_candidates(db, VIEWER, None, None, window=10_000)
        assert len(candidates) <= 101

    def test_page_is_built_from_ranked_ids(self, db, seeded):
        candidates = fetch_for_you_candidates(db, VIEWER, None, None, window=20)
        chosen = [doc_id for doc_id, _ in candidates][:5][::-1]
        page = build_for_you_page(candidates, chosen, 5, None, VIEWER, window=20)
        assert ids_of(page) == chosen

    def test_pages_advance_by_window_without_duplicates(self, db, seeded):
        window = 10
        first_candidates = fetch_for_you_candidates(db, VIEWER, None, None, window=window)
        first = build_for_you_page(
            first_candidates, [i for i, _ in first_candidates], 5, None, VIEWER, window=window
        )
        assert first.next_cursor
        cursor = decode_cursor(first.next_cursor, MODE_FOR_YOU, None)

        second_candidates = fetch_for_you_candidates(db, VIEWER, None, cursor, window=window)
        second = build_for_you_page(
            second_candidates, [i for i, _ in second_candidates], 5, None, VIEWER, window=window
        )
        assert not (set(ids_of(first)) & set(ids_of(second)))

    def test_unknown_ranked_ids_are_ignored(self, db, seeded):
        candidates = fetch_for_you_candidates(db, VIEWER, None, None, window=10)
        page = build_for_you_page(candidates, ["ghost1", "ghost2"], 5, None, VIEWER, window=10)
        assert page.posts == []

    def test_empty_candidate_set(self):
        page = build_for_you_page([], [], 10, None, VIEWER)
        assert page.posts == [] and page.has_more is False


# ------------------------------------------------------------ HTTP contract

@pytest.fixture
def client():
    app_module.app.config.update(TESTING=True)
    with app_module.app.test_client() as test_client:
        yield test_client


@pytest.fixture(autouse=True)
def clean_limiters():
    rate_limit.reset_all_limiters()
    yield
    rate_limit.reset_all_limiters()


@pytest.fixture
def signed_in(monkeypatch, db):
    """Authenticated caller whose requests reach the emulator-backed store.

    The Admin SDK has no credentials in tests, so app.get_db() is pointed at
    the same emulator client the service-level tests use.
    """
    monkeypatch.setattr(
        auth_module, "verify_request_token",
        lambda: {"uid": VIEWER, "email": "viewer@example.com"},
    )
    monkeypatch.setattr(app_module, "get_db", lambda: db)
    return {"Authorization": "Bearer fake-but-accepted"}


class TestFeedEndpointContract:
    def test_requires_authentication(self, client):
        assert client.post("/feed", json={"mode": "discover"}).status_code == 401

    def test_rejects_an_unknown_mode(self, client, signed_in):
        response = client.post("/feed", json={"mode": "hackermode"}, headers=signed_in)
        assert response.status_code == 400

    def test_rejects_client_supplied_posts(self, client, signed_in):
        """The whole point of Phase 4: the client cannot inject post data."""
        response = client.post(
            "/feed",
            json={"mode": "discover", "posts": [{"id": "fake", "likesCount": 999999}]},
            headers=signed_in,
        )
        assert response.status_code == 400
        assert "posts" in response.get_json()["message"]

    def test_rejects_client_supplied_preferences(self, client, signed_in):
        response = client.post(
            "/feed",
            json={"mode": "foryou", "userPreferences": {"streetwear": 9999}},
            headers=signed_in,
        )
        assert response.status_code == 400

    def test_rejects_a_spoofed_uid(self, client, signed_in):
        response = client.post("/feed", json={"mode": "discover", "uid": "someone_else"},
                               headers=signed_in)
        assert response.status_code == 400

    def test_rejects_an_unknown_category(self, client, signed_in):
        response = client.post("/feed", json={"mode": "discover", "category": "'; DROP--"},
                               headers=signed_in)
        assert response.status_code == 400

    def test_rejects_a_malformed_cursor(self, client, signed_in):
        response = client.post("/feed", json={"mode": "discover", "cursor": "!!!not-valid!!!"},
                               headers=signed_in)
        assert response.status_code == 400

    def test_rejects_a_non_integer_limit(self, client, signed_in):
        response = client.post("/feed", json={"mode": "discover", "limit": "lots"},
                               headers=signed_in)
        assert response.status_code == 400

    def test_caps_an_oversized_limit_rather_than_failing(self, client, signed_in, db, seeded):
        response = client.post("/feed", json={"mode": "discover", "limit": 10_000},
                               headers=signed_in)
        assert response.status_code == 200
        assert len(response.get_json()["posts"]) <= 30

    def test_returns_the_documented_envelope(self, client, signed_in, db, seeded):
        response = client.post("/feed", json={"mode": "discover", "limit": 5}, headers=signed_in)
        assert response.status_code == 200
        body = response.get_json()
        assert set(body) == {"posts", "nextCursor", "hasMore", "mode", "category"}
        assert isinstance(body["posts"], list)
        assert isinstance(body["hasMore"], bool)

    def test_for_you_returns_ranking_explanations(self, client, signed_in, db, seeded):
        response = client.post("/feed", json={"mode": "foryou", "limit": 5}, headers=signed_in)
        assert response.status_code == 200
        posts = response.get_json()["posts"]
        assert posts
        assert all("_rankingFactors" in p for p in posts)

    def test_responses_never_include_the_likedby_array(self, client, signed_in, db, seeded):
        response = client.post("/feed", json={"mode": "discover", "limit": 5}, headers=signed_in)
        for item in response.get_json()["posts"]:
            assert "likedBy" not in item
            assert "likedByMe" in item

    def test_following_with_no_follows_is_an_empty_page(self, client, signed_in):
        response = client.post("/feed", json={"mode": "following"}, headers=signed_in)
        assert response.status_code == 200
        body = response.get_json()
        assert body["posts"] == [] and body["hasMore"] is False


class TestFollowScaleAndSampling:
    """Following must not silently drop accounts at any follow count."""

    import pytest as _pytest

    @_pytest.mark.parametrize("count", [0, 1, 10, 11, 100])
    def test_at_or_under_the_cap_every_author_is_queried(self, count):
        from feed_service import select_followed_authors
        ids = [f"author{i:04d}" for i in range(count)]
        selected, sampled = select_followed_authors(ids, "uid", "2026-06-01")
        assert sampled is False
        assert set(selected) == set(ids)

    @_pytest.mark.parametrize("count", [101, 150, 500])
    def test_over_the_cap_samples_explicitly(self, count):
        from feed_service import MAX_FOLLOWED_AUTHORS, select_followed_authors
        ids = [f"author{i:04d}" for i in range(count)]
        selected, sampled = select_followed_authors(ids, "uid", "2026-06-01")
        assert sampled is True, "sampling must be reported, never silent"
        assert len(selected) == MAX_FOLLOWED_AUTHORS
        assert set(selected) <= set(ids)
        assert len(set(selected)) == len(selected)

    def test_sampling_is_deterministic_within_a_day(self):
        from feed_service import select_followed_authors
        ids = [f"author{i:04d}" for i in range(300)]
        first, _ = select_followed_authors(ids, "uid", "2026-06-01")
        second, _ = select_followed_authors(ids, "uid", "2026-06-01")
        assert first == second

    def test_the_window_rotates_across_days(self):
        from feed_service import select_followed_authors
        ids = [f"author{i:04d}" for i in range(300)]
        day1, _ = select_followed_authors(ids, "uid", "2026-06-01")
        day2, _ = select_followed_authors(ids, "uid", "2026-06-02")
        # Authors outside one slice are not permanently invisible.
        assert set(day1) != set(day2)

    def test_different_users_get_different_windows(self):
        from feed_service import select_followed_authors
        ids = [f"author{i:04d}" for i in range(300)]
        a, _ = select_followed_authors(ids, "alice", "2026-06-01")
        b, _ = select_followed_authors(ids, "bob", "2026-06-01")
        assert set(a) != set(b)

    def test_chunking_covers_every_selected_author(self, db, seeded):
        """All 100 selected authors must actually be queried, not just 10."""
        from feed_service import IN_QUERY_CHUNK, MAX_FOLLOWED_AUTHORS
        authors = [f"{seeded['prefix']}_author{i % 3}" for i in range(3)]
        authors += [f"filler_{i:04d}" for i in range(MAX_FOLLOWED_AUTHORS - 3)]
        page = fetch_following(db, VIEWER, 10, None, None, authors)
        assert page.queries_issued == MAX_FOLLOWED_AUTHORS // IN_QUERY_CHUNK
        assert page.posts

    def test_the_response_reports_sampling(self, client, signed_in, db):
        uid = VIEWER
        created = []
        batch = db.batch()
        for i in range(120):
            doc_id = f"{uid}_scaletarget{i:04d}"
            batch.set(db.collection("follows").document(doc_id),
                      {"followerId": uid, "followingId": f"scaletarget{i:04d}"})
            created.append(doc_id)
        batch.commit()
        try:
            response = client.post("/feed", json={"mode": "following"}, headers=signed_in)
            assert response.status_code == 200
            body = response.get_json()
            assert body["followingSampled"] is True
            assert body["followingTotal"] == 120
            assert body["followingQueried"] == 100
        finally:
            cleanup = db.batch()
            for doc_id in created:
                cleanup.delete(db.collection("follows").document(doc_id))
            cleanup.commit()
