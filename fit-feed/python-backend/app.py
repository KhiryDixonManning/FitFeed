# app.py

from flask import Flask, request, jsonify
from flask_cors import CORS
from recommendation_engine import rank_posts, get_trending

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


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(debug=True)