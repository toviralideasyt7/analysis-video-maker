#!/usr/bin/env python3
"""Build video-spec.json for the best-selling game consoles video."""
import json
import sys

def build_spec(project_id, title, subtitle, start_year, end_year,
               n_frames, dataset_id):
    years = [str(y) for y in range(start_year, end_year + 1)]
    # Split the race into 3 scenes for pacing (like the browsers video)
    total = n_frames
    s1_end = total // 3
    s2_end = 2 * total // 3

    def race_scene(sid, tape_range, duration):
        return {
            "id": sid,
            "type": "bar_race",
            "duration": duration,
            "datasetRef": dataset_id,
            "props": {
                "tapeRef": "frames.json",
                "topN": 10,
                "periodLabels": years,
                "tapeRange": list(tape_range),
                "highlights": [],
                "notes": [],
                "summary": "",
            },
        }

    # Fact boxes at interesting moments (console launches)
    def fact_box(sid, at_label, heading, body):
        return {
            "id": sid,
            "type": "fact_box",
            "duration": 14,
            "datasetRef": dataset_id,
            "props": {
                "atLabel": at_label,
                "heading": heading,
                "body": body,
            },
        }

    scenes = [
        {
            "id": "scene_title",
            "type": "title",
            "duration": 8,
            "datasetRef": dataset_id,
        },
        {
            "id": "scene_intro",
            "type": "intro",
            "duration": 25,
            "datasetRef": dataset_id,
            "props": {
                "title": title,
                "subtitle": f"Cumulative units sold, {start_year}–{end_year}",
            },
        },
        race_scene("scene_race_1", (0, s1_end), 54),
        fact_box(
            "scene_spotlight_ps2",
            "2000",
            "PlayStation 2 launches",
            "Sony's PlayStation 2 arrives in 2000 and goes on to become the "
            "best-selling game console of all time at over 160 million units.",
        ),
        race_scene("scene_race_2", (s1_end, s2_end), 54),
        fact_box(
            "scene_spotlight_wii",
            "2006",
            "Nintendo's motion-control bet",
            "The Wii's motion controls bring gaming to a whole new audience, "
            "selling over 100 million units.",
        ),
        race_scene("scene_race_3", (s2_end, total - 1), 54),
        {
            "id": "scene_ending",
            "type": "ending",
            "duration": 15,
            "datasetRef": dataset_id,
        },
    ]

    return {
        "version": "1.0",
        "metadata": {
            "title": title,
            "subtitle": subtitle,
            "language": "en",
            "durationSeconds": sum(s["duration"] for s in scenes),
        },
        "canvas": {"width": 1280, "height": 720, "fps": 30},
        "theme": {
            "background": "#ffffff",
            "surface": "#f8fafc",
            "primaryText": "#1f2937",
            "secondaryText": "#4b5563",
            "mutedText": "#9ca3af",
            "accent": "#7c3aed",
            "barTrack": "#e5e7eb",
            "fontFamily": "Inter, system-ui, sans-serif",
        },
        "datasetRef": dataset_id,
        "scenes": scenes,
        "assets": [],
        "sources": [
            {
                "publisher": "Wikipedia / manufacturer reports",
                "url": "https://en.wikipedia.org/wiki/List_of_best-selling_game_consoles",
                "retrievedAt": "2026-09-25T00:00:00Z",
                "identifier": "wikipedia-best-selling-game-consoles",
            }
        ],
    }


def main():
    project_id = sys.argv[1]
    frames_file = sys.argv[2]
    out_file = sys.argv[3]
    with open(frames_file) as f:
        tape = json.load(f)
    years = [int(y) for y in tape["periodLabels"]]
    spec = build_spec(
        project_id,
        "Best-Selling Game Consoles",
        f"{min(years)} - {max(years)}",
        min(years),
        max(years),
        len(tape["frames"]),
        f"dataset_{project_id}",
    )
    with open(out_file, "w") as f:
        json.dump(spec, f, indent=2)
    print(f"Wrote {out_file}")


if __name__ == "__main__":
    main()
