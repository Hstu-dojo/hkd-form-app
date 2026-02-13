import { PDFDocument } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { PHOTO_BOX, SIGNATURE_POSITIONS, FORM_FIELDS, FIELD_COORDS } from "./form-fields";

// Base path for public assets (needed for GitHub Pages subpath deployment)
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

export type FormData = Record<string, string>;

export interface ImageData {
  photo?: string; // base64 data URL
  signature?: string; // base64 data URL
}

/**
 * Render text to a PNG data URL using the browser's Canvas API.
 * This works for ALL scripts (Latin, Bengali, Arabic, etc.) because
 * the browser has built-in font rendering and shaping support.
 */
function renderTextToImage(text: string, fieldWidth: number, fieldHeight: number): string {
  const scale = 4; // High-res for crisp text in PDF
  const fontSize = fieldHeight * 0.85; // Slightly smaller than field height
  const canvasWidth = fieldWidth * scale;
  const canvasHeight = fieldHeight * scale;

  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  // Transparent background
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  // Render text using system fonts — browser handles Bangla/Unicode natively
  ctx.fillStyle = "#000000";
  ctx.font = `${fontSize * scale}px "Noto Sans Bengali", "Noto Sans", Arial, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 1 * scale, canvasHeight / 2);

  return canvas.toDataURL("image/png");
}

/**
 * Fill the PDF form with text data and images, all client-side.
 *
 * Strategy: Draw all text as canvas-rendered PNG images directly on the PDF page.
 * This bypasses font/encoding issues entirely — the browser's Canvas API handles
 * all scripts (Bangla, Latin, etc.) perfectly, and the resulting images work in
 * every PDF viewer without depending on NeedAppearances support.
 */
export async function fillPdfForm(
  formValues: FormData,
  images: ImageData
): Promise<Uint8Array> {
  // Fetch the blank PDF template from public folder
  const response = await fetch(`${BASE_PATH}/blank-form.pdf`);
  const pdfBytes = await response.arrayBuffer();

  // Load the PDF
  const pdfDoc = await PDFDocument.load(pdfBytes);
  pdfDoc.registerFontkit(fontkit);

  // Get the form and the first page
  const form = pdfDoc.getForm();
  const page = pdfDoc.getPages()[0];

  // Build the PDF field data from form values
  const pdfFieldData: Record<string, string> = {};
  for (const field of FORM_FIELDS) {
    const value = formValues[field.id];
    if (value !== undefined && value !== "") {
      pdfFieldData[field.pdfFieldId] = value;
    }
  }

  // Draw each field's text as a rendered image on the page
  for (const [fieldName, fieldValue] of Object.entries(pdfFieldData)) {
    const coords = FIELD_COORDS[fieldName];
    if (!coords) continue;

    try {
      const pngDataUrl = renderTextToImage(fieldValue, coords.w, coords.h);
      if (pngDataUrl) {
        const pngBytes = dataUrlToUint8Array(pngDataUrl);
        const pngImage = await pdfDoc.embedPng(pngBytes);
        page.drawImage(pngImage, {
          x: coords.x,
          y: coords.y,
          width: coords.w,
          height: coords.h,
        });
      }
    } catch (err) {
      console.warn(`Could not render field ${fieldName}:`, err);
    }
  }

  // Remove form fields so they don't overlay the drawn text
  try {
    form.flatten();
  } catch {
    // Flatten may fail on some fields, that's OK — text images are already drawn
  }

  // Add photo image if provided
  if (images.photo) {
    try {
      const photoBytes = dataUrlToUint8Array(images.photo);
      const photoType = getImageType(images.photo);

      let image;
      if (photoType === "png") {
        image = await pdfDoc.embedPng(photoBytes);
      } else {
        image = await pdfDoc.embedJpg(photoBytes);
      }

      page.drawImage(image, {
        x: PHOTO_BOX.x,
        y: PHOTO_BOX.y,
        width: PHOTO_BOX.width,
        height: PHOTO_BOX.height,
      });
    } catch (err) {
      console.error("Error embedding photo:", err);
    }
  }

  // Add signature image if provided
  if (images.signature) {
    try {
      const sigBytes = dataUrlToUint8Array(images.signature);
      const sigType = getImageType(images.signature);

      let sigImage;
      if (sigType === "png") {
        sigImage = await pdfDoc.embedPng(sigBytes);
      } else {
        sigImage = await pdfDoc.embedJpg(sigBytes);
      }

      const pos = SIGNATURE_POSITIONS.student;
      page.drawImage(sigImage, {
        x: pos.x,
        y: pos.y,
        width: pos.width,
        height: pos.height,
      });
    } catch (err) {
      console.error("Error embedding signature:", err);
    }
  }

  // Save the PDF (form is flattened, no field appearances needed)
  const filledPdfBytes = await pdfDoc.save();
  return filledPdfBytes;
}

/**
 * Convert a data URL to Uint8Array
 */
function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Get image type from data URL
 */
function getImageType(dataUrl: string): "png" | "jpg" {
  if (dataUrl.includes("image/png")) return "png";
  return "jpg";
}

/**
 * Trigger file download in browser
 */
export function downloadPdf(pdfBytes: Uint8Array, filename: string) {
  const blob = new Blob([new Uint8Array(pdfBytes)], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Download the blank form
 */
export function downloadBlankForm() {
  const a = document.createElement("a");
  a.href = `${BASE_PATH}/blank-form.pdf`;
  a.download = "HSTU_Karate_Dojo_Form_Blank.pdf";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * Validate an image file
 */
export interface ImageValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  dimensions?: { width: number; height: number };
}

export function validateImage(
  file: File,
  type: "photo" | "signature"
): Promise<ImageValidationResult> {
  return new Promise((resolve) => {
    const errors: string[] = [];
    const warnings: string[] = [];

    const constraints =
      type === "photo"
        ? {
            maxSizeMB: 5,
            maxSizeBytes: 5 * 1024 * 1024,
            acceptedTypes: ["image/jpeg", "image/png", "image/jpg"],
            minWidth: 150,
            minHeight: 180,
            maxWidth: 2000,
            maxHeight: 2400,
            recommendedWidth: 300,
            recommendedHeight: 360,
            aspectRatioMin: 0.6,
            aspectRatioMax: 1.0,
          }
        : {
            maxSizeMB: 2,
            maxSizeBytes: 2 * 1024 * 1024,
            acceptedTypes: ["image/jpeg", "image/png", "image/jpg"],
            minWidth: 50,
            minHeight: 20,
            maxWidth: 2000,
            maxHeight: 1000,
            recommendedWidth: 400,
            recommendedHeight: 150,
            aspectRatioMin: 0.5,
            aspectRatioMax: 8.0,
          };

    // Check file type
    if (!constraints.acceptedTypes.includes(file.type)) {
      errors.push(
        `Invalid file type: ${file.type || "unknown"}. Please upload a JPG or PNG image.`
      );
    }

    // Check file size
    if (file.size > constraints.maxSizeBytes) {
      errors.push(
        `File size (${(file.size / 1024 / 1024).toFixed(1)}MB) exceeds the maximum of ${constraints.maxSizeMB}MB.`
      );
    }

    // Check dimensions
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      const { width, height } = img;

      if (width < constraints.minWidth || height < constraints.minHeight) {
        errors.push(
          `Image is too small (${width}×${height}px). Minimum size: ${constraints.minWidth}×${constraints.minHeight}px.`
        );
      }

      if (width > constraints.maxWidth || height > constraints.maxHeight) {
        warnings.push(
          `Image is very large (${width}×${height}px). It will be resized. Recommended: ${constraints.recommendedWidth}×${constraints.recommendedHeight}px.`
        );
      }

      const aspectRatio = width / height;
      if (
        aspectRatio < constraints.aspectRatioMin ||
        aspectRatio > constraints.aspectRatioMax
      ) {
        if (type === "photo") {
          warnings.push(
            `Image aspect ratio (${aspectRatio.toFixed(2)}) is unusual for a ${type}. A portrait orientation (ratio ~0.75) is recommended.`
          );
        } else {
          warnings.push(
            `Image aspect ratio (${aspectRatio.toFixed(2)}) is unusual for a ${type}. A landscape orientation (ratio ~2.5) is recommended.`
          );
        }
      }

      resolve({
        valid: errors.length === 0,
        errors,
        warnings,
        dimensions: { width, height },
      });
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      errors.push("Could not read image file. It may be corrupted.");
      resolve({ valid: false, errors, warnings });
    };

    img.src = objectUrl;
  });
}

/**
 * Read a file as data URL (base64)
 */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Save form data to localStorage
 */
export function saveFormToLocalStorage(formData: FormData, images: ImageData) {
  try {
    localStorage.setItem("hstu_karate_form_data", JSON.stringify(formData));
    // Images stored separately due to size
    if (images.photo) {
      localStorage.setItem("hstu_karate_photo", images.photo);
    }
    if (images.signature) {
      localStorage.setItem("hstu_karate_signature", images.signature);
    }
  } catch (e) {
    console.warn("Could not save to localStorage:", e);
  }
}

/**
 * Load form data from localStorage
 */
export function loadFormFromLocalStorage(): {
  formData: FormData;
  images: ImageData;
} {
  try {
    const formDataStr = localStorage.getItem("hstu_karate_form_data");
    const photo = localStorage.getItem("hstu_karate_photo");
    const signature = localStorage.getItem("hstu_karate_signature");

    return {
      formData: formDataStr ? JSON.parse(formDataStr) : {},
      images: {
        photo: photo || undefined,
        signature: signature || undefined,
      },
    };
  } catch {
    return { formData: {}, images: {} };
  }
}

/**
 * Clear form data from localStorage
 */
export function clearFormLocalStorage() {
  localStorage.removeItem("hstu_karate_form_data");
  localStorage.removeItem("hstu_karate_photo");
  localStorage.removeItem("hstu_karate_signature");
}
