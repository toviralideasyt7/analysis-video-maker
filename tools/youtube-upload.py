#!/usr/bin/env python3
"""
Upload a rendered video to YouTube with AI-generated metadata and thumbnail.

Env required:
  YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN

Usage:
  python3 tools/youtube-upload.py \
    --video projects/<id>/renders/<id>-final.mp4 \
    --thumbnail projects/<id>/renders/<id>-thumbnail.jpg \
    --metadata projects/<id>/renders/metadata.json \
    [--privacy public|unlisted|private] [--dry-run]

Prints the video URL on success. Exits non-zero on failure.
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request

TOKEN_URL = "https://oauth2.googleapis.com/token"
UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status"


def refresh_access_token(client_id: str, client_secret: str, refresh_token: str) -> str:
    data = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }).encode()
    req = urllib.request.Request(TOKEN_URL, data=data,
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["access_token"]


def api(method: str, url: str, token: str, body=None, ctype="application/json") -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Authorization": f"Bearer {token}",
                                          "Content-Type": ctype})
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read()
        return json.loads(raw) if raw else {}


def upload_video(video_path: str, meta: dict, token: str, privacy: str) -> str:
    body = {
        "snippet": {
            "title": meta["title"][:100],
            "description": meta["description"],
            "tags": meta.get("tags", [])[:500],
            "categoryId": "28",  # Science & Technology
        },
        "status": {"privacyStatus": privacy, "selfDeclaredMadeForKids": False},
    }
    size = os.path.getsize(video_path)
    # Initiate resumable upload
    req = urllib.request.Request(
        UPLOAD_URL, data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                 "X-Upload-Content-Length": str(size), "X-Upload-Content-Type": "video/mp4"})
    with urllib.request.urlopen(req, timeout=60) as r:
        session_url = r.headers["Location"]
    # Upload the bytes (single chunk is fine for our sizes)
    with open(video_path, "rb") as f:
        payload = f.read()
    req = urllib.request.Request(
        session_url, data=payload, method="PUT",
        headers={"Content-Length": str(size), "Content-Type": "video/mp4"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.loads(r.read())["id"]


def set_thumbnail(video_id: str, thumb_path: str, token: str) -> None:
    with open(thumb_path, "rb") as f:
        payload = f.read()
    ctype = "image/jpeg" if thumb_path.lower().endswith((".jpg", ".jpeg")) else "image/png"
    url = f"https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId={video_id}"
    req = urllib.request.Request(url, data=payload, method="POST",
                                 headers={"Authorization": f"Bearer {token}",
                                          "Content-Type": ctype,
                                          "Content-Length": str(len(payload))})
    with urllib.request.urlopen(req, timeout=120):
        pass


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--thumbnail", default="")
    ap.add_argument("--metadata", required=True)
    ap.add_argument("--privacy", default="public", choices=["public", "unlisted", "private"])
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    cid = os.environ.get("YOUTUBE_CLIENT_ID", "")
    csec = os.environ.get("YOUTUBE_CLIENT_SECRET", "")
    rtok = os.environ.get("YOUTUBE_REFRESH_TOKEN", "")
    if not (cid and csec and rtok):
        print("missing YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN",
              file=sys.stderr)
        return 2
    with open(args.metadata) as f:
        meta = json.load(f)
    print(f"title: {meta['title']}")
    print(f"tags: {len(meta.get('tags', []))}")
    if args.dry_run:
        print("dry-run: skipping upload")
        return 0

    token = refresh_access_token(cid, csec, rtok)
    video_id = upload_video(args.video, meta, token, args.privacy)
    print(f"uploaded video id: {video_id}")
    if args.thumbnail and os.path.exists(args.thumbnail):
        set_thumbnail(video_id, args.thumbnail, token)
        print("thumbnail set")
    print(f"https://www.youtube.com/watch?v={video_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
