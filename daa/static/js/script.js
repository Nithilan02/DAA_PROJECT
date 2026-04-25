/**
 * Smart Image Resizer — Seam Carving
 * Frontend Logic (Vanilla JavaScript)
 *
 * Handles image upload, API calls to Flask backend,
 * Canvas rendering for energy maps & seam visualization,
 * and all interactive UI controls.
 */

// ================================================================
// DOM Elements
// ================================================================
const $ = (sel) => document.querySelector(sel);
const fileInput       = $("#file-input");
const browseBtn       = $("#browse-btn");
const uploadArea      = $("#upload-area");
const uploadPreview   = $("#upload-preview");
const previewImg      = $("#preview-img");
const imgDimensions   = $("#img-dimensions");
const workspace       = $("#workspace");
const btnEnergy       = $("#btn-energy");
const btnFindSeam     = $("#btn-find-seam");
const btnRemoveOne    = $("#btn-remove-one");
const btnRemoveMulti  = $("#btn-remove-multi");
const btnSliderApply  = $("#btn-slider-apply");
const btnReset        = $("#btn-reset");
const btnDownload     = $("#btn-download");
const seamCountInput  = $("#seam-count");
const widthSlider     = $("#width-slider");
const sliderValue     = $("#slider-value");
const seamDirection   = $("#seam-direction");
const canvasCurrent   = $("#canvas-current");
const canvasEnergy    = $("#canvas-energy");
const energyPlaceholder = $("#energy-placeholder");
const infoDimensions  = $("#info-dimensions");
const infoSeams       = $("#info-seams");
const infoTime        = $("#info-time");
const loadingOverlay  = $("#loading-overlay");
const loadingText     = $("#loading-text");
const comparisonSection = $("#comparison-section");
const compareOriginal = $("#compare-original");
const compareCarved   = $("#compare-carved");
const canvasCropped   = $("#canvas-cropped");
const canvasCarvedCompare = $("#canvas-carved-compare");
const dpContainer     = $("#dp-matrix-container");

// ================================================================
// State
// ================================================================
let currentImageB64   = null;  // base64 of current image
let originalImageB64  = null;  // base64 of original image
let currentWidth      = 0;
let currentHeight     = 0;
let originalWidth     = 0;
let originalHeight    = 0;
let totalSeamsRemoved = 0;

// ================================================================
// Utility Functions
// ================================================================

/** Show the loading overlay with a message */
function showLoading(msg = "Processing…") {
    loadingText.textContent = msg;
    loadingOverlay.classList.remove("hidden");
}

/** Hide the loading overlay */
function hideLoading() {
    loadingOverlay.classList.add("hidden");
}

/** Draw a base64 image on a canvas element */
function drawBase64OnCanvas(canvas, b64, callback) {
    const img = new Image();
    img.onload = () => {
        canvas.width  = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        if (callback) callback(ctx, img);
    };
    img.src = "data:image/png;base64," + b64;
}

/** Update info bar */
function updateInfo(w, h, seams, time) {
    if (w !== undefined && h !== undefined) {
        infoDimensions.textContent = `${w} × ${h} px`;
        currentWidth = w;
        currentHeight = h;
    }
    if (seams !== undefined) {
        infoSeams.textContent = `Seams removed: ${seams}`;
        totalSeamsRemoved = seams;
    }
    if (time !== undefined) {
        infoTime.textContent = `⏱ ${time}s`;
    }
}

/** Update the comparison section */
function updateComparison() {
    if (!originalImageB64 || !currentImageB64) return;

    comparisonSection.classList.remove("hidden");

    // Set comparison images
    compareOriginal.src = "data:image/png;base64," + originalImageB64;
    compareCarved.src   = "data:image/png;base64," + currentImageB64;

    // Draw cropped version for comparison
    const cropImg = new Image();
    cropImg.onload = () => {
        const targetW = currentWidth;
        const targetH = currentHeight;
        canvasCropped.width  = targetW;
        canvasCropped.height = targetH;
        const ctx = canvasCropped.getContext("2d");
        // Center crop from original
        const sx = Math.floor((cropImg.width - targetW) / 2);
        const sy = 0;
        ctx.drawImage(cropImg, sx, sy, targetW, targetH, 0, 0, targetW, targetH);
    };
    cropImg.src = "data:image/png;base64," + originalImageB64;

    // Draw seam-carved version
    drawBase64OnCanvas(canvasCarvedCompare, currentImageB64);
}

// ================================================================
// Drag & Drop / File Upload
// ================================================================

uploadArea.addEventListener("click", () => fileInput.click());
browseBtn.addEventListener("click", (e) => { e.stopPropagation(); fileInput.click(); });

uploadArea.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadArea.classList.add("drag-over");
});
uploadArea.addEventListener("dragleave", () => {
    uploadArea.classList.remove("drag-over");
});
uploadArea.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadArea.classList.remove("drag-over");
    if (e.dataTransfer.files.length) {
        fileInput.files = e.dataTransfer.files;
        handleUpload(e.dataTransfer.files[0]);
    }
});

fileInput.addEventListener("change", () => {
    if (fileInput.files.length) handleUpload(fileInput.files[0]);
});

/**
 * Upload the selected file to the backend.
 */
async function handleUpload(file) {
    showLoading("Uploading image…");

    const formData = new FormData();
    formData.append("image", file);

    try {
        const res  = await fetch("/upload", { method: "POST", body: formData });
        const data = await res.json();

        if (!data.success) {
            alert(data.error || "Upload failed");
            hideLoading();
            return;
        }

        // Store image data
        currentImageB64  = data.image;
        originalImageB64 = data.image;
        currentWidth  = data.width;
        currentHeight = data.height;
        originalWidth = data.width;
        originalHeight = data.height;
        totalSeamsRemoved = 0;

        // Show preview
        previewImg.src = "data:image/png;base64," + data.image;
        imgDimensions.textContent = `${data.width} × ${data.height} px`;
        uploadPreview.classList.remove("hidden");

        // Show workspace
        workspace.classList.remove("hidden");
        drawBase64OnCanvas(canvasCurrent, data.image);
        updateInfo(data.width, data.height, 0);

        // Update slider max
        widthSlider.max = Math.min(50, Math.floor((data.width - 2) / data.width * 100));
        widthSlider.value = 0;
        sliderValue.textContent = "0%";

        // Reset panels
        energyPlaceholder.classList.remove("hidden");
        comparisonSection.classList.add("hidden");
        dpContainer.innerHTML = '<p class="dp-placeholder">Find a seam first to see the DP matrix sample.</p>';

        // Scroll to workspace
        workspace.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
        alert("Upload error: " + err.message);
    }
    hideLoading();
}

// ================================================================
// Energy Map
// ================================================================

btnEnergy.addEventListener("click", async () => {
    showLoading("Computing energy map…");

    try {
        const res  = await fetch("/energy", { method: "POST" });
        const data = await res.json();

        if (!data.success) { alert(data.error); hideLoading(); return; }

        drawBase64OnCanvas(canvasEnergy, data.energy_image);
        energyPlaceholder.classList.add("hidden");
        updateInfo(data.width, data.height, undefined, data.processing_time);
    } catch (err) {
        alert("Error: " + err.message);
    }
    hideLoading();
});

// ================================================================
// Find Seam
// ================================================================

btnFindSeam.addEventListener("click", async () => {
    showLoading("Finding minimum-energy seam…");

    try {
        const direction = seamDirection.value;
        const res  = await fetch("/seam", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ direction }),
        });
        const data = await res.json();

        if (!data.success) { alert(data.error); hideLoading(); return; }

        // Draw image with seam highlighted
        drawBase64OnCanvas(canvasCurrent, data.seam_image, (ctx, img) => {
            // Animate the seam path
            animateSeam(ctx, data.seam, img.width, img.height);
        });

        updateInfo(undefined, undefined, undefined, data.processing_time);

        // DP Matrix visualization
        if (data.dp_sample && data.dp_sample.length > 0) {
            renderDPMatrix(data.dp_sample);
        }
    } catch (err) {
        alert("Error: " + err.message);
    }
    hideLoading();
});

/**
 * Animate the seam path on the canvas by drawing it progressively.
 */
function animateSeam(ctx, seam, imgW, imgH) {
    if (!seam || seam.length === 0) return;

    let idx = 0;
    const step = Math.max(1, Math.floor(seam.length / 60)); // ~60 frames

    function frame() {
        for (let s = 0; s < step && idx < seam.length; s++, idx++) {
            const [r, c] = seam[idx];
            ctx.fillStyle = "rgba(255, 50, 50, 0.9)";
            ctx.fillRect(c, r, 1, 1);
            // Glow effect
            ctx.fillStyle = "rgba(255, 100, 100, 0.4)";
            ctx.fillRect(c - 1, r, 3, 1);
        }
        if (idx < seam.length) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
}

/**
 * Render a sample of the DP cost matrix as an HTML table.
 */
function renderDPMatrix(matrix) {
    const rows = matrix.length;
    const cols = matrix[0].length;

    // Find min/max for color mapping
    let minVal = Infinity, maxVal = -Infinity;
    for (const row of matrix) {
        for (const v of row) {
            if (v < minVal) minVal = v;
            if (v > maxVal) maxVal = v;
        }
    }
    const range = maxVal - minVal || 1;

    let html = '<table class="dp-matrix">';
    for (let i = 0; i < rows; i++) {
        html += "<tr>";
        for (let j = 0; j < cols; j++) {
            const val = matrix[i][j];
            const norm = (val - minVal) / range;
            const r = Math.round(108 * norm + 20);
            const g = Math.round(92 * norm + 20);
            const b = Math.round(231 * norm + 40);
            const bg = `rgba(${r}, ${g}, ${b}, ${0.3 + norm * 0.5})`;
            html += `<td style="background:${bg}">${Math.round(val)}</td>`;
        }
        html += "</tr>";
    }
    html += "</table>";
    dpContainer.innerHTML = html;
}

// ================================================================
// Remove Seams
// ================================================================

btnRemoveOne.addEventListener("click", () => removeSeams(1));
btnRemoveMulti.addEventListener("click", () => {
    const n = parseInt(seamCountInput.value, 10) || 1;
    removeSeams(n);
});

btnSliderApply.addEventListener("click", () => {
    const pct = parseInt(widthSlider.value, 10);
    if (pct <= 0) return;
    const targetReduction = Math.max(1, Math.round(currentWidth * pct / 100));
    removeSeams(targetReduction);
});

async function removeSeams(count) {
    const direction = seamDirection.value;
    const label = direction === "vertical" ? "width" : "height";
    showLoading(`Removing ${count} ${direction} seam${count > 1 ? "s" : ""}… (reducing ${label})`);

    try {
        const res  = await fetch("/remove", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ count, direction }),
        });
        const data = await res.json();

        if (!data.success) { alert(data.error); hideLoading(); return; }

        currentImageB64 = data.image;
        currentWidth    = data.width;
        currentHeight   = data.height;

        drawBase64OnCanvas(canvasCurrent, data.image);
        updateInfo(data.width, data.height, data.seams_removed, data.processing_time);

        // Update comparison
        updateComparison();

        // If seam data provided, animate the last seam on the current canvas
        if (data.seams && data.seams.length > 0) {
            // We'll just show the comparison, seams are already removed
        }
    } catch (err) {
        alert("Error: " + err.message);
    }
    hideLoading();
}

// ================================================================
// Slider Value Display
// ================================================================

widthSlider.addEventListener("input", () => {
    sliderValue.textContent = widthSlider.value + "%";
});

// ================================================================
// Reset
// ================================================================

btnReset.addEventListener("click", async () => {
    showLoading("Resetting to original…");

    try {
        const res  = await fetch("/reset", { method: "POST" });
        const data = await res.json();

        if (!data.success) { alert(data.error); hideLoading(); return; }

        currentImageB64 = data.image;
        currentWidth  = data.width;
        currentHeight = data.height;
        totalSeamsRemoved = 0;

        drawBase64OnCanvas(canvasCurrent, data.image);
        updateInfo(data.width, data.height, 0);

        comparisonSection.classList.add("hidden");
        energyPlaceholder.classList.remove("hidden");
        dpContainer.innerHTML = '<p class="dp-placeholder">Find a seam first to see the DP matrix sample.</p>';

        // Reset slider
        widthSlider.value = 0;
        sliderValue.textContent = "0%";
    } catch (err) {
        alert("Error: " + err.message);
    }
    hideLoading();
});

// ================================================================
// Download
// ================================================================

btnDownload.addEventListener("click", () => {
    window.location.href = "/download";
});

// ================================================================
// Smooth Scroll for Nav Links
// ================================================================

document.querySelectorAll('.nav-links a').forEach(link => {
    link.addEventListener("click", (e) => {
        const target = document.querySelector(link.getAttribute("href"));
        if (target) {
            e.preventDefault();
            target.scrollIntoView({ behavior: "smooth", block: "start" });
        }
    });
});

// ================================================================
// Navbar background on scroll
// ================================================================

window.addEventListener("scroll", () => {
    const nav = $("#navbar");
    if (window.scrollY > 50) {
        nav.style.background = "rgba(10,10,15,.95)";
    } else {
        nav.style.background = "rgba(10,10,15,.85)";
    }
});
