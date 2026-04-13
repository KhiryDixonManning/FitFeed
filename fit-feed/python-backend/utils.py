# utils.py

from datetime import datetime, timezone


def convert_timestamp(ts):
    """
    Converts different timestamp formats into a naive UTC datetime object.
    Supports:
    - datetime object (aware or naive)
    - Firestore serialized timestamp dict: { "_seconds": int, "_nanoseconds": int }
    - Unix timestamp (ms or seconds)
    - ISO string (including Z suffix and +00:00 offset)
    """

    if isinstance(ts, datetime):
        if ts.tzinfo is not None:
            return ts.astimezone(timezone.utc).replace(tzinfo=None)
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
            # Normalize Z suffix so fromisoformat handles it on all Python versions
            normalized = ts.replace("Z", "+00:00")
            dt = datetime.fromisoformat(normalized)
            if dt.tzinfo is not None:
                return dt.astimezone(timezone.utc).replace(tzinfo=None)
            return dt
        except Exception:
            return datetime.utcnow()

    return datetime.utcnow()
