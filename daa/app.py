"""
Smart Image Resizer using Seam Carving Algorithm
Flask Backend — app.py

Implements content-aware image resizing via the Seam Carving
dynamic programming algorithm. Provides REST API endpoints for
the frontend to upload images, compute energy maps, find seams,
remove seams, and download results.
"""

import os
import time
import uuid
import base64
import json
from io import BytesIO

import numpy as np
from PIL import Image, ImageDraw
from flask import Flask, render_template, request, jsonify, send_file

# ---------------------------------------------------------------------------
# Flask App Configuration
# ---------------------------------------------------------------------------

app = Flask(__name__)
app.config["UPLOAD_FOLDER"] = os.path.join("static", "uploads")
app.config["OUTPUT_FOLDER"] = os.path.join("static", "output")
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024  # 16 MB max upload

# Ensure directories exist
os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
os.makedirs(app.config["OUTPUT_FOLDER"], exist_ok=True)

# In-memory store for the current working image (per-session simplicity)
state = {
    "original_path": None,
    "current_image": None,   # NumPy array (H, W, 3) uint8
    "original_image": None,  # NumPy array (H, W, 3) uint8
    "energy_map": None,      # NumPy array (H, W) float64
    "seam": None,            # list of (row, col) tuples
    "seams_removed": 0,
}

# ---------------------------------------------------------------------------
# Seam Carving Core Functions
# ---------------------------------------------------------------------------

def compute_energy(img: np.ndarray) -> np.ndarray:
    """
    Compute the energy of each pixel using a gradient-based method
    (dual-gradient energy function similar to Sobel operator).

    Energy(x,y) = |dI/dx| + |dI/dy|   (sum of absolute gradients)

    Parameters
    ----------
    img : np.ndarray
        Image array of shape (H, W, 3), dtype uint8.

    Returns
    -------
    np.ndarray
        Energy map of shape (H, W), dtype float64.
    """
    # Convert to float for gradient calculation
    gray = np.mean(img.astype(np.float64), axis=2)

    # Gradients using np.roll (handles borders via wrap)
    dx = np.abs(np.roll(gray, -1, axis=1) - np.roll(gray, 1, axis=1))
    dy = np.abs(np.roll(gray, -1, axis=0) - np.roll(gray, 1, axis=0))

    energy = dx + dy
    return energy


def find_vertical_seam(energy: np.ndarray):
    """
    Find the minimum-energy vertical seam using Dynamic Programming.

    Recurrence:
        M[i, j] = Energy(i, j) + min(M[i-1, j-1], M[i-1, j], M[i-1, j+1])

    Time Complexity: O(W × H)
    Space Complexity: O(W × H) for the cost matrix

    Parameters
    ----------
    energy : np.ndarray
        Energy map of shape (H, W).

    Returns
    -------
    seam : list[tuple[int, int]]
        List of (row, col) from top to bottom.
    dp_matrix : np.ndarray
        The DP cost matrix M of shape (H, W).
    """
    H, W = energy.shape
    # DP cost matrix
    M = np.copy(energy)

    # Fill DP table row by row
    for i in range(1, H):
        for j in range(W):
            # Left, center, right parents
            left = M[i - 1, j - 1] if j > 0 else np.inf
            center = M[i - 1, j]
            right = M[i - 1, j + 1] if j < W - 1 else np.inf
            M[i, j] = energy[i, j] + min(left, center, right)

    # Backtrack from the bottom row to find the seam
    seam = []
    j = int(np.argmin(M[-1]))
    for i in range(H - 1, -1, -1):
        seam.append((i, j))
        if i == 0:
            break
        # Determine which parent we came from
        left = M[i - 1, j - 1] if j > 0 else np.inf
        center = M[i - 1, j]
        right = M[i - 1, j + 1] if j < W - 1 else np.inf
        min_val = min(left, center, right)
        if min_val == left:
            j -= 1
        elif min_val == right:
            j += 1
        # else: j stays the same (center)

    seam.reverse()
    return seam, M


def find_horizontal_seam(energy: np.ndarray):
    """
    Find the minimum-energy horizontal seam by transposing and
    finding a vertical seam.

    Returns
    -------
    seam : list[tuple[int, int]]
        List of (row, col) in the original orientation.
    dp_matrix : np.ndarray
        The DP cost matrix in transposed form.
    """
    # Transpose energy, find vertical seam, then swap coordinates back
    seam_t, dp = find_vertical_seam(energy.T)
    seam = [(c, r) for r, c in seam_t]
    return seam, dp


def remove_vertical_seam(img: np.ndarray, seam: list) -> np.ndarray:
    """
    Remove one vertical seam from the image.

    Parameters
    ----------
    img : np.ndarray
        Image of shape (H, W, 3).
    seam : list[tuple[int, int]]
        The seam to remove.

    Returns
    -------
    np.ndarray
        New image of shape (H, W-1, 3).
    """
    H, W, C = img.shape
    mask = np.ones((H, W), dtype=bool)
    for r, c in seam:
        mask[r, c] = False
    new_img = img[mask].reshape(H, W - 1, C)
    return new_img


def remove_horizontal_seam(img: np.ndarray, seam: list) -> np.ndarray:
    """
    Remove one horizontal seam from the image.

    Parameters
    ----------
    img : np.ndarray
        Image of shape (H, W, 3).
    seam : list[tuple[int, int]]
        The seam to remove as (row, col) pairs.

    Returns
    -------
    np.ndarray
        New image of shape (H-1, W, 3).
    """
    H, W, C = img.shape
    mask = np.ones((H, W), dtype=bool)
    for r, c in seam:
        mask[r, c] = False
    new_img = img[mask].reshape(H - 1, W, C)
    return new_img


def numpy_to_base64(img_array: np.ndarray, fmt: str = "PNG") -> str:
    """Convert a NumPy image array to a base64-encoded string."""
    pil_img = Image.fromarray(img_array.astype(np.uint8))
    buffer = BytesIO()
    pil_img.save(buffer, format=fmt)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def energy_to_base64(energy: np.ndarray) -> str:
    """
    Normalize energy map to 0-255 and convert to base64 grayscale image.
    """
    normalized = (energy - energy.min()) / (energy.max() - energy.min() + 1e-8) * 255
    return numpy_to_base64(normalized.astype(np.uint8))


def draw_seam_on_image(img: np.ndarray, seam: list, color=(255, 0, 0)) -> np.ndarray:
    """
    Draw a seam on a copy of the image.
    """
    overlay = img.copy()
    for r, c in seam:
        overlay[r, c] = color
        # Thicken the seam for visibility
        if c > 0:
            overlay[r, c - 1] = color
        if c < overlay.shape[1] - 1:
            overlay[r, c + 1] = color
    return overlay


# ---------------------------------------------------------------------------
# Flask Routes
# ---------------------------------------------------------------------------

@app.route("/")
def home():
    """Serve the single-page application."""
    return render_template("index.html")


@app.route("/upload", methods=["POST"])
def upload():
    """
    Upload an image file.
    Returns image dimensions and a base64 preview.
    """
    if "image" not in request.files:
        return jsonify({"error": "No image file provided"}), 400

    file = request.files["image"]
    if file.filename == "":
        return jsonify({"error": "No file selected"}), 400

    # Save to uploads
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in (".jpg", ".jpeg", ".png", ".bmp", ".webp"):
        return jsonify({"error": "Unsupported file format"}), 400

    filename = f"{uuid.uuid4().hex}{ext}"
    filepath = os.path.join(app.config["UPLOAD_FOLDER"], filename)
    file.save(filepath)

    # Load into memory
    pil_img = Image.open(filepath).convert("RGB")
    img_array = np.array(pil_img)

    # Limit size for performance (max 800px wide)
    H, W = img_array.shape[:2]
    if W > 800:
        ratio = 800 / W
        new_w = 800
        new_h = int(H * ratio)
        pil_img = pil_img.resize((new_w, new_h), Image.LANCZOS)
        img_array = np.array(pil_img)

    state["original_path"] = filepath
    state["current_image"] = img_array.copy()
    state["original_image"] = img_array.copy()
    state["energy_map"] = None
    state["seam"] = None
    state["seams_removed"] = 0

    h, w = img_array.shape[:2]
    return jsonify({
        "success": True,
        "width": w,
        "height": h,
        "image": numpy_to_base64(img_array),
    })


@app.route("/energy", methods=["POST"])
def energy():
    """
    Compute and return the energy map of the current image.
    """
    if state["current_image"] is None:
        return jsonify({"error": "No image loaded"}), 400

    t0 = time.time()
    energy_map = compute_energy(state["current_image"])
    elapsed = round(time.time() - t0, 4)

    state["energy_map"] = energy_map

    return jsonify({
        "success": True,
        "energy_image": energy_to_base64(energy_map),
        "processing_time": elapsed,
        "width": energy_map.shape[1],
        "height": energy_map.shape[0],
    })


@app.route("/seam", methods=["POST"])
def seam():
    """
    Find the minimum-energy vertical seam and return it.
    Also returns a version of the image with the seam drawn in red.
    """
    if state["current_image"] is None:
        return jsonify({"error": "No image loaded"}), 400

    direction = request.json.get("direction", "vertical") if request.is_json else "vertical"

    t0 = time.time()
    energy_map = compute_energy(state["current_image"])
    state["energy_map"] = energy_map

    if direction == "horizontal":
        seam_path, dp_matrix = find_horizontal_seam(energy_map)
    else:
        seam_path, dp_matrix = find_vertical_seam(energy_map)

    elapsed = round(time.time() - t0, 4)
    state["seam"] = seam_path

    # Draw seam on image
    seam_image = draw_seam_on_image(state["current_image"], seam_path)

    # Get a small sample of the DP matrix for visualization (top-left 10x10)
    sample_size = min(10, dp_matrix.shape[0], dp_matrix.shape[1])
    dp_sample = dp_matrix[:sample_size, :sample_size].tolist()

    return jsonify({
        "success": True,
        "seam": seam_path,
        "seam_image": numpy_to_base64(seam_image),
        "processing_time": elapsed,
        "dp_sample": dp_sample,
        "direction": direction,
    })


@app.route("/remove", methods=["POST"])
def remove():
    """
    Remove seam(s) from the current image.
    Accepts JSON body: { "count": <int>, "direction": "vertical"|"horizontal" }
    """
    if state["current_image"] is None:
        return jsonify({"error": "No image loaded"}), 400

    data = request.get_json(force=True) if request.is_json else {}
    count = int(data.get("count", 1))
    direction = data.get("direction", "vertical")

    img = state["current_image"]
    H, W = img.shape[:2]

    # Safety limit
    if direction == "vertical":
        count = min(count, W - 2)
    else:
        count = min(count, H - 2)

    t0 = time.time()
    seams_data = []
    for i in range(count):
        energy_map = compute_energy(img)
        if direction == "vertical":
            seam_path, _ = find_vertical_seam(energy_map)
            img = remove_vertical_seam(img, seam_path)
        else:
            seam_path, _ = find_horizontal_seam(energy_map)
            img = remove_horizontal_seam(img, seam_path)
        seams_data.append(seam_path)

    elapsed = round(time.time() - t0, 4)
    state["current_image"] = img
    state["seams_removed"] += count
    state["seam"] = None
    state["energy_map"] = None

    h, w = img.shape[:2]
    return jsonify({
        "success": True,
        "image": numpy_to_base64(img),
        "width": w,
        "height": h,
        "seams_removed": state["seams_removed"],
        "processing_time": elapsed,
        "original_width": state["original_image"].shape[1],
        "original_height": state["original_image"].shape[0],
        "seams": seams_data if count <= 5 else [],  # only send seam data for small counts
    })


@app.route("/reset", methods=["POST"])
def reset():
    """Reset to the original uploaded image."""
    if state["original_image"] is None:
        return jsonify({"error": "No image loaded"}), 400

    state["current_image"] = state["original_image"].copy()
    state["energy_map"] = None
    state["seam"] = None
    state["seams_removed"] = 0
    img = state["current_image"]
    h, w = img.shape[:2]

    return jsonify({
        "success": True,
        "image": numpy_to_base64(img),
        "width": w,
        "height": h,
    })


@app.route("/download", methods=["GET"])
def download():
    """Download the current (resized) image as PNG."""
    if state["current_image"] is None:
        return jsonify({"error": "No image loaded"}), 400

    pil_img = Image.fromarray(state["current_image"].astype(np.uint8))
    filepath = os.path.join(app.config["OUTPUT_FOLDER"], "resized_image.png")
    pil_img.save(filepath)
    return send_file(filepath, as_attachment=True, download_name="seam_carved_image.png")


# ---------------------------------------------------------------------------
# Entry Point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    app.run(debug=True, port=5000)
