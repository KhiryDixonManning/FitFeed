# Read-only diagnostic: fetch the CURRENTLY DEPLOYED Firestore/Storage rules
# via the Firebase Rules API to compare against the local rules files.
# Makes no changes; prints rule source only (no tokens/credentials).
import os
import requests
from firebase_admin import credentials

cred = credentials.Certificate(os.path.join(os.path.dirname(__file__), "serviceAccountKey.json"))
token = cred.get_access_token().access_token
H = {"Authorization": f"Bearer {token}"}
BASE = "https://firebaserules.googleapis.com/v1/projects/fitfeed-67ee8"

rel = requests.get(f"{BASE}/releases", headers=H, timeout=20)
rel.raise_for_status()
for r in rel.json().get("releases", []):
    print("RELEASE:", r["name"].split("/")[-1], "->", r["rulesetName"].split("/")[-1], "updated:", r.get("updateTime"))
    rs = requests.get(f"https://firebaserules.googleapis.com/v1/{r['rulesetName']}", headers=H, timeout=20)
    rs.raise_for_status()
    for f in rs.json()["source"]["files"]:
        print(f"----- {f['name']} -----")
        print(f["content"])
    print()
