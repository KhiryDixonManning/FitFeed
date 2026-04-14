# 👗 FitFeed — Personalized Fashion, Powered by Data

![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)
![Firebase](https://img.shields.io/badge/Firebase-FFCA28?style=for-the-badge&logo=firebase&logoColor=black)
![Railway](https://img.shields.io/badge/Railway-0B0D0E?style=for-the-badge&logo=railway&logoColor=white)

> **Turning outfits into structured data to power personalized style discovery.**

---

## 🚀 Overview

FitFeed is a fashion-focused social media platform where users share real outfits, receive AI-powered analysis, and discover content tailored to their personal style.

Most platforms treat fashion as static content.  
FitFeed treats fashion as **data** — combining user behavior, AI analysis, and real-time ranking to create a feed that evolves with each user.

Built in 5 weeks by a team of 3, FitFeed demonstrates a full-stack system with:
- real-time data
- AI enrichment
- recommendation systems
- scalable architecture design

---

## ✨ Features

### 🤖 AI Outfit Analysis Pipeline
- Runs automatically after upload (non-blocking)
- Extracts **5 dominant colors** using KMeans clustering
- Sends image to Claude AI (base64 encoded)
- Returns:
  - Aesthetic category
  - Style tags
  - Detected clothing items
  - 2-sentence style description
  - Aesthetic scores (0.0 → 1.0)
- Writes results back to Firestore in real time
- Upload succeeds even if AI fails (resilient design)

---

### 🔥 Personalized Feed
- Multi-factor ranking system using:
  - Engagement (likes & comments)
  - Recency (time decay)
  - User preferences
- Includes exploration factor to prevent repetition
- Graceful fallback if ranking API is offline

---

### 🧠 Personalization System
- Likes → +1 to category score
- Comments → +2 (stronger signal)
- Stored per user in Firestore
- Discover mode surfaces unseen categories

---

### ⚡ Real-Time Feed
- Firestore `onSnapshot` listener updates UI instantly
- AI results appear without refresh
- Debounced API calls prevent spam
- Live "analyzing" indicator for pending posts

---

### 📊 Style Profile
- Radar chart visualization (Recharts)
- Tracks preferences across 10 categories
- Displays top style badge
- Animated transitions + empty state

---

### 🧰 Additional Features
- Firebase Auth (protected routes)
- Image compression (5MB → ~300KB)
- Optimistic UI updates
- Comment system with indexing
- Leaderboard ("Aura Farmers")
- Public profile pages
- Fully responsive (mobile-first)
- Bottom tab navigation (mobile UX)
- Playwright test suite

---

## 🧱 Architecture

```
User Uploads Outfit
↓
Firebase Storage + Firestore
↓
Flask /analyze API (async)
├── KMeans (color extraction)
└── Claude AI (style analysis)
↓
Firestore updated with results
↓
Real-time listener updates UI
↓
User interactions (likes/comments)
↓
User preferences updated
↓
Flask /rank API scores posts
↓
Personalized Feed
```

---

## ⚙️ Tech Stack

### 🎨 Frontend
- React + TypeScript
- Vite
- Tailwind CSS v4
- React Router
- Recharts

---

### ☁️ Backend / Database
- Firebase Authentication
- Firestore (posts, users, preferences)
- Firebase Storage (images)

---

### 🧠 Intelligence Layer
- Python Flask API
- Scikit-learn (KMeans clustering)
- Pillow (image processing)
- NumPy

---

### 🤖 AI Integration
- Anthropic Claude API
  - Style tags
  - Outfit descriptions
  - Aesthetic scoring

---

### 🧪 Testing & Tooling
- Playwright
- Concurrently
- Firebase Admin SDK
- python-dotenv
- Git & GitHub
- Firebase CLI

---

## 🧠 Recommendation Algorithm (Simplified)

FitFeed ranks posts using a weighted scoring system:

| Signal        | Description |
|--------------|------------|
| Engagement   | Likes (0.4) + Comments (0.6) |
| Recency      | Exponential decay based on post age |
| Preference   | Matches user interaction history |
| Exploration  | Small randomness to diversify feed |

### Final Score:

```
Score = (Engagement × 0.5) + (Recency × 0.3) + (Preference × 0.2)
```

This allows the feed to:
- prioritize relevant content
- stay fresh
- adapt to user behavior over time

---

## 🤖 AI Analysis Pipeline

Each outfit is enriched using:

1. **Image Processing**
   - Resize + compress image
   - Extract dominant colors via KMeans

2. **Claude AI Analysis**
   - Identify aesthetic category
   - Generate style tags
   - Detect clothing items
   - Create description
   - Assign aesthetic scores

3. **Data Enrichment**
   - Results stored in Firestore
   - Immediately reflected in UI

---

## 🛠️ Getting Started

### Prerequisites
- Node.js 18+
- Python 3.10+
- Firebase CLI
- Railway CLI

---

### 🔧 Installation

#### Frontend
```bash
npm install
npm run dev:frontend
```

#### Backend

**Windows**
```bash
cd fit-feed/python-backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

**Mac / Linux**
```bash
cd fit-feed/python-backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python app.py
```

### 🔐 Environment Variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key |

**Required Files**
- `fit-feed/python-backend/.env`
- `fit-feed/python-backend/serviceAccountKey.json`

---

## 📜 Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Runs frontend + backend together |
| `npm run dev:frontend` | Runs React app |
| `npm run build` | Builds production bundle |
| `npm run preview` | Preview production build |

---

## 🚀 Deployment

**Frontend**  
Firebase Hosting  
👉 https://fitfeed-67ee8.web.app

**Backend**  
Railway  
👉 https://fitfeed-api-production.up.railway.app

---

## 🧪 Testing

Run Playwright tests:

```bash
npx playwright test
```

Covers:
- authentication
- feed rendering
- API endpoints

---

## 🌟 Why This Project Stands Out
- Multi-layer architecture (not just CRUD)
- Real-time data synchronization
- AI used for data enrichment, not just labeling
- Custom recommendation system
- Separation of frontend, backend, and intelligence layer
- Designed like a real production system

---

## 👥 Team

| Role | Responsibility |
|---|---|
| Khiry (ML Engineer) | Recommendation system, AI pipeline, Flask API, personalization, style profile |
| Max (Frontend) | UI, routing, responsive design |
| Jimwall (Backend) | Firebase Auth, Firestore, storage, security |

---

## 📬 Contact

Feel free to reach out for questions, feedback, or collaboration.
