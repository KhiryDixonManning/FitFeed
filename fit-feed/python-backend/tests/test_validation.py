import pytest

from validation import (
    MAX_RANK_POSTS,
    ValidationError,
    require_json_object,
    require_post_id,
    validate_analysis_output,
    validate_posts_payload,
    validate_preferences,
)


class TestRequestValidation:
    def test_missing_body_is_rejected(self):
        with pytest.raises(ValidationError):
            require_json_object(None)

    def test_non_object_body_is_rejected(self):
        for body in ([], "string", 42):
            with pytest.raises(ValidationError):
                require_json_object(body)

    def test_valid_object_passes(self):
        assert require_json_object({"a": 1}) == {"a": 1}

    def test_post_id_must_be_present_and_sane(self):
        assert require_post_id({"postId": "abc123"}) == "abc123"
        with pytest.raises(ValidationError):
            require_post_id({})
        with pytest.raises(ValidationError):
            require_post_id({"postId": ""})
        with pytest.raises(ValidationError):
            require_post_id({"postId": 123})

    def test_post_id_rejects_path_traversal(self):
        for bad in ("../../etc/passwd", "posts/abc", ".."):
            with pytest.raises(ValidationError):
                require_post_id({"postId": bad})

    def test_post_id_length_is_bounded(self):
        with pytest.raises(ValidationError):
            require_post_id({"postId": "x" * 500})


class TestPostsPayload:
    def test_absent_list_defaults_to_empty(self):
        assert validate_posts_payload({}, MAX_RANK_POSTS) == []

    def test_accepts_a_normal_list(self):
        posts = [{"id": "1"}, {"id": "2"}]
        assert validate_posts_payload({"posts": posts}, MAX_RANK_POSTS) == posts

    def test_rejects_non_list(self):
        with pytest.raises(ValidationError):
            validate_posts_payload({"posts": {"id": "1"}}, MAX_RANK_POSTS)

    def test_rejects_non_object_entries(self):
        with pytest.raises(ValidationError):
            validate_posts_payload({"posts": ["not-an-object"]}, MAX_RANK_POSTS)

    def test_caps_the_number_of_posts(self):
        too_many = [{"id": str(i)} for i in range(MAX_RANK_POSTS + 1)]
        with pytest.raises(ValidationError) as excinfo:
            validate_posts_payload({"posts": too_many}, MAX_RANK_POSTS)
        assert excinfo.value.status == 413

    def test_exactly_at_the_cap_is_allowed(self):
        at_cap = [{"id": str(i)} for i in range(MAX_RANK_POSTS)]
        assert len(validate_posts_payload({"posts": at_cap}, MAX_RANK_POSTS)) == MAX_RANK_POSTS


class TestPreferences:
    def test_keeps_numeric_values_only(self):
        prefs = validate_preferences({"streetwear": 5, "vintage": "lots", "y2k": 2.5, "x": None})
        assert prefs == {"streetwear": 5.0, "y2k": 2.5}

    def test_rejects_booleans_and_infinities(self):
        assert validate_preferences({"a": True, "b": float("inf"), "c": float("nan")}) == {}

    def test_non_dict_is_empty(self):
        assert validate_preferences(None) == {}
        assert validate_preferences(["streetwear"]) == {}


class TestAnalysisOutputSchema:
    def valid_payload(self):
        return {
            "aesthetic": "streetwear",
            "aestheticTags": ["oversized", "retro"],
            "detectedItems": ["hoodie", "jeans"],
            "outfitName": "Cobalt Hoodie Standby",
            "styleDescription": "Two sentences.",
            "styleNotes": "Deeper analysis.",
            "aestheticScores": {"streetwear": 0.9, "y2k": 0.3},
            "colors": [{"hex": "#4A69BD", "name": "Cobalt", "percentage": 55}],
        }

    def test_valid_payload_survives(self):
        out = validate_analysis_output(self.valid_payload())
        assert out is not None
        assert out["aesthetic"] == "streetwear"
        assert out["colors"][0]["hex"] == "#4A69BD"
        assert out["aestheticScores"]["streetwear"] == 0.9

    def test_garbage_returns_none(self):
        assert validate_analysis_output(None) is None
        assert validate_analysis_output("a string") is None
        assert validate_analysis_output([1, 2, 3]) is None
        assert validate_analysis_output({}) is None

    def test_unknown_aesthetic_is_dropped(self):
        payload = self.valid_payload()
        payload["aesthetic"] = "hacker-injected-value"
        out = validate_analysis_output(payload)
        assert out["aesthetic"] is None

    def test_unknown_score_keys_are_dropped(self):
        payload = self.valid_payload()
        payload["aestheticScores"] = {"streetwear": 0.5, "notarealaesthetic": 0.9}
        out = validate_analysis_output(payload)
        assert "notarealaesthetic" not in out["aestheticScores"]
        assert out["aestheticScores"]["streetwear"] == 0.5

    def test_scores_are_clamped_to_unit_range(self):
        payload = self.valid_payload()
        payload["aestheticScores"] = {"streetwear": -4, "vintage": 85, "y2k": 400}
        out = validate_analysis_output(payload)
        for value in out["aestheticScores"].values():
            assert 0.0 <= value <= 1.0
        # 85 is interpreted as a percentage
        assert out["aestheticScores"]["vintage"] == 0.85

    def test_invalid_hex_colors_are_discarded(self):
        payload = self.valid_payload()
        payload["colors"] = [
            {"hex": "not-a-color", "name": "x", "percentage": 10},
            {"hex": "#GGGGGG", "name": "x", "percentage": 10},
            {"hex": "#abc", "name": "x", "percentage": 10},
            {"hex": "#00ff00", "name": "Lime", "percentage": 10},
        ]
        out = validate_analysis_output(payload)
        assert len(out["colors"]) == 1
        assert out["colors"][0]["hex"] == "#00FF00"

    def test_color_percentages_are_clamped(self):
        payload = self.valid_payload()
        payload["colors"] = [{"hex": "#000000", "name": "Onyx", "percentage": 5000}]
        out = validate_analysis_output(payload)
        assert out["colors"][0]["percentage"] == 100

    def test_list_lengths_are_capped(self):
        payload = self.valid_payload()
        payload["aestheticTags"] = [f"tag{i}" for i in range(50)]
        payload["detectedItems"] = [f"item{i}" for i in range(50)]
        payload["colors"] = [{"hex": "#010101", "name": "n", "percentage": 1}] * 50
        out = validate_analysis_output(payload)
        assert len(out["aestheticTags"]) <= 8
        assert len(out["detectedItems"]) <= 12
        assert len(out["colors"]) <= 5

    def test_long_strings_are_truncated(self):
        payload = self.valid_payload()
        payload["outfitName"] = "x" * 5000
        payload["styleNotes"] = "y" * 99999
        out = validate_analysis_output(payload)
        assert len(out["outfitName"]) <= 120
        assert len(out["styleNotes"]) <= 1500

    def test_wrong_types_inside_lists_are_skipped(self):
        payload = self.valid_payload()
        payload["aestheticTags"] = ["good", 42, None, {"nested": "object"}, "also good"]
        out = validate_analysis_output(payload)
        assert out["aestheticTags"] == ["good", "also good"]

    def test_partial_payload_still_usable(self):
        out = validate_analysis_output({"outfitName": "Just A Name"})
        assert out is not None
        assert out["outfitName"] == "Just A Name"
        assert out["colors"] == []
