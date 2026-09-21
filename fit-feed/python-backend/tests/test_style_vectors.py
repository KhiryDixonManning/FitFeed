"""Style vectors, canonicalisation and taste similarity."""

from __future__ import annotations

import time

import pytest

from style_vectors import (
    CANONICAL_AESTHETICS,
    STYLE_VECTOR_VERSION,
    canonical_aesthetic,
    canonical_garment,
    color_family,
    cosine_similarity,
    post_style_vector,
    style_similarity,
)


class TestCanonicalisation:
    def test_exact_names_pass_through(self):
        for name in CANONICAL_AESTHETICS:
            assert canonical_aesthetic(name) == name

    def test_case_and_whitespace_are_normalised(self):
        assert canonical_aesthetic("  STREETWEAR ") == "streetwear"
        assert canonical_aesthetic("Y2K") == "y2k"

    def test_aliases_map_onto_canonical_dimensions(self):
        assert canonical_aesthetic("grunge") == "alternative"
        assert canonical_aesthetic("street wear") == "streetwear"
        assert canonical_aesthetic("retro") == "vintage"
        assert canonical_aesthetic("workwear") == "business casual"

    def test_phrases_containing_a_known_name(self):
        assert canonical_aesthetic("soft minimalist energy") == "minimalist"

    def test_unknown_values_are_dropped_not_given_a_dimension(self):
        for junk in ["", None, 42, [], "zzzz nonsense", "   "]:
            assert canonical_aesthetic(junk) is None

    def test_garment_bucketing(self):
        assert canonical_garment("light wash denim jeans") == "bottom"
        assert canonical_garment("cropped bomber jacket") == "outerwear"
        assert canonical_garment("chunky white sneakers") == "footwear"
        assert canonical_garment("gold necklace") == "accessory"
        assert canonical_garment("quantum flux capacitor") is None

    def test_color_families(self):
        assert color_family("#000000") == "black"
        assert color_family("#FFFFFF") == "white"
        assert color_family("#1E90FF") == "blue"
        assert color_family("#2E8B57") == "green"
        assert color_family("#808080") == "neutral"

    def test_malformed_colors_are_dropped(self):
        for bad in ["", "#GGGGGG", "#abc", None, 123, "not-a-color"]:
            assert color_family(bad) is None


class TestPostStyleVector:
    def full_post(self):
        return {
            "category": "streetwear",
            "aesthetic": "streetwear",
            "aestheticScores": {"streetwear": 0.9, "y2k": 0.4, "vintage": 0.2},
            "aestheticTags": ["oversized", "retro"],
            "detectedItems": ["hoodie", "jeans", "sneakers"],
            "palette": [
                {"hex": "#1E90FF", "name": "Cobalt", "percentage": 60},
                {"hex": "#000000", "name": "Onyx", "percentage": 40},
            ],
        }

    def test_versioned_and_shaped(self):
        vector = post_style_vector(self.full_post())
        assert vector["version"] == STYLE_VECTOR_VERSION
        assert set(vector) == {"version", "aesthetics", "tags", "items", "colors"}

    def test_values_are_bounded(self):
        vector = post_style_vector(self.full_post())
        for facet in ("aesthetics", "tags", "items", "colors"):
            for value in vector[facet].values():
                assert 0.0 <= value <= 1.0

    def test_dominant_aesthetic_is_strongest(self):
        vector = post_style_vector(self.full_post())
        assert vector["aesthetics"]["streetwear"] >= max(vector["aesthetics"].values())

    def test_garments_are_bucketed_not_free_text(self):
        vector = post_style_vector(self.full_post())
        assert set(vector["items"]) <= {"outerwear", "top", "bottom", "dress",
                                        "footwear", "accessory"}

    def test_legacy_post_with_only_a_category(self):
        vector = post_style_vector({"category": "vintage"})
        assert vector["aesthetics"].get("vintage", 0) > 0

    def test_legacy_post_with_string_palette(self):
        vector = post_style_vector({"category": "minimalist", "palette": ["#FFFFFF", "#000000"]})
        assert vector["colors"]

    def test_completely_empty_post(self):
        vector = post_style_vector({})
        assert vector["version"] == STYLE_VECTOR_VERSION
        assert vector["aesthetics"] == {}

    def test_malformed_fields_do_not_raise(self):
        junk = {
            "category": 42,
            "aesthetic": [],
            "aestheticScores": "not a map",
            "aestheticTags": "not a list",
            "detectedItems": {"nope": 1},
            "palette": "purple",
        }
        vector = post_style_vector(junk)
        assert vector["aesthetics"] == {}

    def test_percentage_scale_scores_are_tolerated(self):
        vector = post_style_vector({"aestheticScores": {"streetwear": 90, "y2k": 40}})
        for value in vector["aesthetics"].values():
            assert 0.0 <= value <= 1.0

    def test_unknown_score_keys_do_not_create_dimensions(self):
        vector = post_style_vector({"aestheticScores": {"cyberpunk_vaporwave_xyz": 0.9}})
        assert "cyberpunk_vaporwave_xyz" not in vector["aesthetics"]

    def test_tag_count_is_bounded(self):
        vector = post_style_vector({"aestheticTags": [f"tag{i}" for i in range(200)]})
        assert len(vector["tags"]) <= 12

    def test_deterministic(self):
        p = self.full_post()
        assert post_style_vector(p) == post_style_vector(p)


class TestSimilarity:
    def test_identical_vectors_are_one(self):
        a = {"streetwear": 1.0, "y2k": 0.5}
        assert cosine_similarity(a, a) == pytest.approx(1.0)

    def test_disjoint_vectors_are_zero(self):
        assert cosine_similarity({"streetwear": 1.0}, {"cottagecore": 1.0}) == 0.0

    def test_bounded_and_never_nan(self):
        cases = [({}, {}), ({"a": 0}, {"a": 0}), ({"a": 1.0}, {}),
                 ({"a": 1e12}, {"a": 1e-12})]
        for a, b in cases:
            value = cosine_similarity(a, b)
            assert 0.0 <= value <= 1.0
            assert value == value  # not NaN

    def test_style_similarity_matches_taste(self):
        taste = {"aesthetics": {"streetwear": 1.0, "y2k": 0.6}}
        close = post_style_vector({"category": "streetwear", "aestheticScores": {"streetwear": 0.9}})
        far = post_style_vector({"category": "cottagecore", "aestheticScores": {"cottagecore": 0.9}})
        assert style_similarity(taste, close) > style_similarity(taste, far)

    def test_missing_vectors_fall_back_to_neutral(self):
        assert style_similarity(None, {"aesthetics": {"a": 1.0}}) == 0.0
        assert style_similarity({"aesthetics": {"a": 1.0}}, None) == 0.0
        assert style_similarity({}, {}) == 0.0
        assert style_similarity("nonsense", 42) == 0.0

    def test_cold_start_profile_is_neutral_not_negative(self):
        empty_taste = {"aesthetics": {}}
        value = style_similarity(empty_taste, post_style_vector({"category": "streetwear"}))
        assert value == 0.0

    def test_bounded_for_every_facet_combination(self):
        taste = {"aesthetics": {"streetwear": 1.0}, "colors": {"blue": 1.0},
                 "tags": {"oversized": 1.0}, "items": {"top": 1.0}}
        vector = post_style_vector({
            "category": "streetwear", "aestheticTags": ["oversized"],
            "detectedItems": ["hoodie"], "palette": [{"hex": "#1E90FF", "percentage": 100}],
        })
        assert 0.0 <= style_similarity(taste, vector) <= 1.0

    def test_deterministic(self):
        taste = {"aesthetics": {"streetwear": 1.0}}
        vector = post_style_vector({"category": "streetwear"})
        assert style_similarity(taste, vector) == style_similarity(taste, vector)


class TestSimilarityPerformance:
    def test_similarity_over_100_candidates_is_negligible_locally(self):
        taste = {"aesthetics": {"streetwear": 1.0, "y2k": 0.5, "vintage": 0.3},
                 "colors": {"blue": 1.0}}
        posts = [
            {"category": CANONICAL_AESTHETICS[i % len(CANONICAL_AESTHETICS)],
             "aestheticScores": {"streetwear": 0.5},
             "palette": [{"hex": "#1E90FF", "percentage": 50}]}
            for i in range(100)
        ]
        vectors = [post_style_vector(p) for p in posts]

        started = time.perf_counter()
        for vector in vectors:
            style_similarity(taste, vector)
        elapsed = time.perf_counter() - started
        # Local wall-clock on developer hardware, not a production claim.
        assert elapsed < 0.5, f"100 similarity computations took {elapsed:.4f}s locally"
