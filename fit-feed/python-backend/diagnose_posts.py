# Read-only diagnostic: inspect post/user docs and check whether stored
# imageUrls are actually fetchable. Makes NO writes to Firestore or Storage.
# Download tokens are redacted from all output.
import re
import firebase_admin
from firebase_admin import credentials, firestore
import requests
import os
import json

cred_path = os.path.join(os.path.dirname(__file__), "serviceAccountKey.json")
firebase_admin.initialize_app(credentials.Certificate(cred_path))
db = firestore.client()

REDACT = re.compile(r"token=[^&\s]+")


def redact(s):
    return REDACT.sub("token=REDACTED", s or "")


posts_newest = list(
    db.collection("posts").order_by("createdAt", direction=firestore.Query.DESCENDING).limit(4).stream()
)
posts_oldest = list(
    db.collection("posts").order_by("createdAt", direction=firestore.Query.ASCENDING).limit(2).stream()
)
seen = set()
sample = [p for p in posts_newest + posts_oldest if p.id not in seen and not seen.add(p.id)]

total = len(list(db.collection("posts").select([]).stream()))
print(f"total posts in collection: {total}")
print(f"--- {len(sample)} sample posts ---")
for p in sample:
    d = p.to_dict()
    url = d.get("imageUrl")
    print(json.dumps({
        "id": p.id,
        "createdAt": str(d.get("createdAt")),
        "authorId": (d.get("authorId") or "")[:8] + "...",
        "analyzed": d.get("analyzed"),
        "imageUrlType": "MISSING" if url is None else ("EMPTY" if url == "" else type(url).__name__),
        "imageUrl": redact(str(url)) if url else None,
    }))

print("--- imageUrl fetch results ---")
for p in sample:
    d = p.to_dict()
    url = d.get("imageUrl")
    if not url or not isinstance(url, str) or not url.startswith("http"):
        print(p.id, "-> NOT_A_URL")
        continue
    try:
        r = requests.get(url, headers={"Range": "bytes=0-64"}, timeout=15)
        body = redact(r.text[:200]) if r.status_code >= 400 else ""
        print(p.id, "->", r.status_code, r.headers.get("content-type", ""), body)
    except Exception as e:
        print(p.id, "-> FETCH_ERROR:", str(e)[:150])

print("--- users docs ---")
author_ids = {p.to_dict().get("authorId") for p in sample if p.to_dict().get("authorId")}
for uid in list(author_ids)[:3]:
    doc = db.collection("users").document(uid).get()
    if doc.exists:
        d = doc.to_dict()
        print(uid[:8] + "...", "exists, keys:", sorted(d.keys()), "photoURL status:", "set" if d.get("photoURL") else "none")
    else:
        print(uid[:8] + "...", "USERS DOC MISSING")
