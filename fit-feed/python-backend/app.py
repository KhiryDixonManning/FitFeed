# app.py

from flask import Flask, request, jsonify
from flask_cors import CORS
from recommendation_engine import rank_posts, get_trending
from outfit_analyzer import analyze_post
from dotenv import load_dotenv
import firebase_admin
from firebase_admin import credentials, firestore as fb_firestore
import os

load_dotenv()

app = Flask(__name__)
CORS(app)  # allows frontend to connect


@app.route("/")
def home():
    return "FitFeed Recommendation API is running"


# 🔥 MAIN FEED (personalized)
@app.route("/rank", methods=["POST"])
def rank():
    data = request.json

    posts = data.get("posts", [])
    user_preferences = data.get("userPreferences", {})

    ranked_posts = rank_posts(posts, user_preferences)

    return jsonify(ranked_posts)


# 🔥 TRENDING PAGE
@app.route("/trending", methods=["POST"])
def trending():
    data = request.json
    posts = data.get("posts", [])

    trending_posts = get_trending(posts)

    return jsonify(trending_posts)


@app.route("/analyze", methods=["POST"])
def analyze():
    data = request.json
    image_url = data.get("imageUrl")
    print(f"[/analyze] Received request for imageUrl: {image_url}")

    if not image_url:
        print("[/analyze] ERROR: No imageUrl in request")
        return jsonify({"error": "No imageUrl provided"}), 400

    result = analyze_post(image_url)
    print(f"[/analyze] Returning result: analyzed={result.get('analyzed')}")
    return jsonify(result)


@app.route("/reanalyze-all", methods=["POST"])
def reanalyze_all():
    try:
        # Initialize Firebase Admin if not already initialized
        if not firebase_admin._apps:
            cred_path = os.path.join(os.path.dirname(__file__), "serviceAccountKey.json")
            cred = credentials.Certificate(cred_path)
            firebase_admin.initialize_app(cred)

        db = fb_firestore.client()
        posts_ref = db.collection("posts")

        # Get all posts that have not been analyzed yet
        posts = posts_ref.where("analyzed", "!=", True).stream()

        updated = 0
        failed = 0

        for post_doc in posts:
            post_data = post_doc.to_dict()
            image_url = post_data.get("imageUrl")

            if not image_url:
                continue

            print(f"[reanalyze] Processing post {post_doc.id}")
            result = analyze_post(image_url)

            if result.get("analyzed"):
                post_doc.reference.update({
                    "palette": result["palette"],
                    "aesthetic": result["aesthetic"],
                    "aestheticTags": result["aestheticTags"],
                    "detectedItems": result["detectedItems"],
                    "styleDescription": result["styleDescription"],
                    "aestheticScores": result["aestheticScores"],
                    "analyzed": True,
                })
                print(f"[reanalyze] Updated post {post_doc.id}")
                updated += 1
            else:
                print(f"[reanalyze] Failed to analyze post {post_doc.id}")
                failed += 1

        return jsonify({
            "message": "Reanalysis complete",
            "updated": updated,
            "failed": failed
        })

    except Exception as e:
        print(f"[reanalyze] Error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(debug=True)