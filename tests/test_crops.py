"""Tests for the shared crops bundle (crops.py) — the cross-node bridge that
moves ⧉ Copy-to-ref crops from Video Edit into the Director library and the
Mockup stage."""

from __future__ import annotations

import os

from ChaoticMinimaxH3Director.crops import (
    BUNDLE_FILENAME,
    load_crops_bundle,
    save_crops_bundle,
)


def test_save_then_load_round_trip(tmp_path):
    result = save_crops_bundle(
        [
            {"file": "ve_crop_1.png", "at": 1.5, "note": "face"},
            {"file": "sub/ve_crop_2.png", "at": 3.2, "note": ""},
        ],
        directory=str(tmp_path),
    )
    assert result["status"] == "ok"
    assert result["count"] == 2
    assert result["path"] == BUNDLE_FILENAME
    assert os.path.exists(os.path.join(str(tmp_path), BUNDLE_FILENAME))

    data = load_crops_bundle(directory=str(tmp_path))
    assert len(data["crops"]) == 2
    assert data["crops"][0]["file"] == "ve_crop_1.png"
    assert data["crops"][0]["at"] == 1.5
    assert data["crops"][0]["note"] == "face"
    assert data["crops"][1]["file"] == "sub/ve_crop_2.png"


def test_save_filters_non_dict_entries(tmp_path):
    result = save_crops_bundle(
        [{"file": "ok.png"}, "junk", None, 42],
        directory=str(tmp_path),
    )
    assert result["status"] == "ok"
    assert result["count"] == 1
    data = load_crops_bundle(directory=str(tmp_path))
    assert len(data["crops"]) == 1
    assert data["crops"][0]["file"] == "ok.png"


def test_load_missing_file_returns_empty(tmp_path):
    assert load_crops_bundle(directory=str(tmp_path / "does-not-exist")) == {"crops": []}


def test_load_corrupt_file_returns_empty(tmp_path):
    path = os.path.join(str(tmp_path), BUNDLE_FILENAME)
    with open(path, "w", encoding="utf-8") as f:
        f.write("this is not json {")
    assert load_crops_bundle(directory=str(tmp_path)) == {"crops": []}


def test_load_non_dict_root_returns_empty(tmp_path):
    path = os.path.join(str(tmp_path), BUNDLE_FILENAME)
    with open(path, "w", encoding="utf-8") as f:
        f.write('["not", "an", "object"]')
    assert load_crops_bundle(directory=str(tmp_path)) == {"crops": []}


def test_load_filters_non_dict_entries(tmp_path):
    path = os.path.join(str(tmp_path), BUNDLE_FILENAME)
    with open(path, "w", encoding="utf-8") as f:
        f.write('{"crops": [{"file": "a.png"}, "junk", {"file": "b.png"}]}')
    data = load_crops_bundle(directory=str(tmp_path))
    assert len(data["crops"]) == 2
    assert [c["file"] for c in data["crops"]] == ["a.png", "b.png"]
