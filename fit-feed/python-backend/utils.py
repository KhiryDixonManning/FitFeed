# utils.py

from datetime import datetime

def convert_timestamp(ts):
    """
    Converts different timestamp formats into a Python datetime object
    Supports:
    - datetime object
    - Firestore serialized timestamp dict: { "_seconds": int, "_nanoseconds": int }
    - Unix timestamp (ms or seconds)
    - ISO string
    """

    if isinstance(ts, datetime):
        return ts

    if isinstance(ts, dict):
        seconds = ts.get("_seconds") or ts.get("seconds")
        if seconds is not None:
            return datetime.utcfromtimestamp(seconds)

    if isinstance(ts, (int, float)):
        if ts > 1e12:
            ts = ts / 1000
        return datetime.utcfromtimestamp(ts)

    if isinstance(ts, str):
        try:
            return datetime.fromisoformat(ts)
        except:
            return datetime.utcnow()

    return datetime.utcnow()
