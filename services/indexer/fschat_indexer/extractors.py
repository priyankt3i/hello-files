from __future__ import annotations

import csv
import io
import json
import mimetypes
import re
import tempfile
import warnings
import zipfile
from pathlib import Path
from typing import Tuple

from docx import Document
from openpyxl import load_workbook

try:
    import fitz  # type: ignore
except ImportError:
    fitz = None

try:
    from PIL import Image, ImageSequence, UnidentifiedImageError
except ImportError:
    Image = None
    ImageSequence = None
    UnidentifiedImageError = Exception

try:
    import numpy as np
except ImportError:
    np = None

try:
    from rapidocr_onnxruntime import RapidOCR
except ImportError:
    RapidOCR = None

try:
    import xlrd  # type: ignore
except ImportError:
    xlrd = None

try:
    import olefile  # type: ignore
except ImportError:
    olefile = None

try:
    import win32com.client  # type: ignore
except ImportError:
    win32com = None


TEXT_EXTENSIONS = {
    ".txt",
    ".md",
    ".csv",
    ".json",
    ".xml",
    ".html",
    ".htm",
    ".yaml",
    ".yml",
    ".ini",
    ".toml",
    ".log",
    ".py",
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".css",
    ".scss",
    ".sql",
    ".sh",
    ".ps1",
    ".bat",
    ".cmd",
    ".java",
    ".cs",
    ".go",
    ".rs",
    ".cpp",
    ".c",
    ".h",
    ".hpp",
    ".swift",
    ".kt",
    ".rb",
    ".php",
    ".swl",
}

SPREADSHEET_EXTENSIONS = {".xlsx", ".xlsm"}
LEGACY_SPREADSHEET_EXTENSIONS = {".xls"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".gif", ".tif", ".tiff", ".webp"}

_OCR_ENGINE = None


def extract_text(path: Path) -> Tuple[str, str]:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return extract_pdf(path), "pdf"
    if suffix == ".docx":
        return extract_docx(path), "docx"
    if suffix == ".doc":
        return extract_doc(path), "doc"
    if suffix in SPREADSHEET_EXTENSIONS:
        return extract_workbook(path), "spreadsheet"
    if suffix in LEGACY_SPREADSHEET_EXTENSIONS:
        return extract_legacy_workbook(path), "spreadsheet-xls"
    if suffix == ".csv":
        return extract_csv(path), "csv"
    if suffix in IMAGE_EXTENSIONS:
        return extract_image_document(path), "image-ocr"
    if suffix in TEXT_EXTENSIONS:
        return extract_plain_text(path), "text"
    return extract_unknown(path)


def extract_pdf(path: Path) -> str:
    if fitz is None:
        raise ValueError("PDF support requires PyMuPDF.")

    parts: list[str] = []
    seen_image_digests: set[int] = set()
    with fitz.open(path) as document:
        for page_index, page in enumerate(document, start=1):
            page_text = page.get_text("text").strip()
            if page_text:
                parts.append(f"# PDF page {page_index}\n{page_text}")

            page_ocr = extract_pdf_page_ocr(page)
            if page_ocr:
                parts.append(f"# PDF page {page_index} visual text\n{page_ocr}")

            for image_index, image_info in enumerate(page.get_images(full=True), start=1):
                image_bytes = document.extract_image(image_info[0]).get("image")
                if not image_bytes:
                    continue
                digest = hash(image_bytes[:2048])
                if digest in seen_image_digests:
                    continue
                seen_image_digests.add(digest)
                embedded_text = extract_image_bytes(
                    image_bytes,
                    f"page {page_index} image {image_index}",
                )
                if embedded_text:
                    parts.append(embedded_text)

    return "\n\n".join(part for part in parts if part.strip())


def extract_pdf_page_ocr(page) -> str:
    if fitz is None:
        return ""
    pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
    image_bytes = pixmap.tobytes("png")
    text = ocr_image_bytes(image_bytes)
    return text.strip()


def extract_docx(path: Path) -> str:
    document = Document(path)
    parts: list[str] = []

    paragraph_text = "\n".join(paragraph.text for paragraph in document.paragraphs if paragraph.text.strip())
    if paragraph_text:
        parts.append(paragraph_text)

    table_text = extract_docx_tables(document)
    if table_text:
        parts.append(table_text)

    embedded_images = extract_docx_embedded_images(path)
    if embedded_images:
        parts.append(embedded_images)

    return "\n\n".join(part for part in parts if part.strip())


def extract_docx_tables(document: Document) -> str:
    rows: list[str] = []
    for table_index, table in enumerate(document.tables, start=1):
        rows.append(f"# Table {table_index}")
        for row in table.rows:
            values = [cell.text.strip() for cell in row.cells if cell.text.strip()]
            if values:
                rows.append(" | ".join(values))
    return "\n".join(rows)


def extract_docx_embedded_images(path: Path) -> str:
    parts: list[str] = []
    with zipfile.ZipFile(path) as archive:
        for name in archive.namelist():
            if not name.startswith("word/media/"):
                continue
            image_bytes = archive.read(name)
            image_text = extract_image_bytes(image_bytes, name)
            if image_text:
                parts.append(image_text)
    return "\n\n".join(parts)


def extract_doc(path: Path) -> str:
    converted_text = extract_doc_via_word(path)
    if converted_text:
        return converted_text

    fallback_text = extract_doc_ole_text(path)
    if fallback_text:
        return fallback_text

    raise ValueError("Legacy .doc extraction requires Microsoft Word or readable OLE text streams.")


def extract_doc_via_word(path: Path) -> str:
    if win32com is None:
        return ""

    word = None
    document = None
    temp_docx = None
    try:
        word = win32com.client.Dispatch("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0
        document = word.Documents.Open(str(path), ReadOnly=True)
        with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as handle:
            temp_docx = Path(handle.name)
        document.SaveAs(str(temp_docx), FileFormat=16)
        return extract_docx(temp_docx)
    except Exception:
        return ""
    finally:
        try:
            if document is not None:
                document.Close(False)
        except Exception:
            pass
        try:
            if word is not None:
                word.Quit()
        except Exception:
            pass
        if temp_docx and temp_docx.exists():
            temp_docx.unlink(missing_ok=True)


def extract_doc_ole_text(path: Path) -> str:
    if olefile is None:
        return ""

    if not olefile.isOleFile(str(path)):
        return ""

    parts: list[str] = []
    with olefile.OleFileIO(str(path)) as ole:
        for stream_name in ole.listdir():
            try:
                raw = ole.openstream(stream_name).read()
            except Exception:
                continue
            extracted = extract_printable_text(raw)
            if extracted:
                parts.append(f"# {'/'.join(stream_name)}\n{extracted}")
    return "\n\n".join(parts)


def extract_legacy_workbook(path: Path) -> str:
    if xlrd is None:
        raise ValueError("Legacy .xls support requires xlrd.")

    workbook = xlrd.open_workbook(path)
    parts: list[str] = []
    for sheet in workbook.sheets():
        parts.append(f"# Sheet: {sheet.name}")
        for row_index in range(sheet.nrows):
            values = [str(sheet.cell_value(row_index, column_index)).strip() for column_index in range(sheet.ncols)]
            values = [value for value in values if value]
            if values:
                parts.append(" | ".join(values))
    return "\n".join(parts)


def extract_workbook(path: Path) -> str:
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message="Conditional Formatting extension is not supported and will be removed",
            category=UserWarning,
            module=r"openpyxl\.worksheet\._reader",
        )
        workbook = load_workbook(path, read_only=True, data_only=True)
    parts: list[str] = []
    for sheet in workbook.worksheets:
        parts.append(f"# Sheet: {sheet.title}")
        for row in sheet.iter_rows(values_only=True):
            values = [str(value).strip() for value in row if value is not None and str(value).strip()]
            if values:
                parts.append(" | ".join(values))
    return "\n".join(parts)


def extract_csv(path: Path) -> str:
    rows: list[str] = []
    with path.open("r", encoding="utf-8", errors="ignore", newline="") as handle:
        reader = csv.reader(handle)
        for row in reader:
            values = [cell.strip() for cell in row if cell and cell.strip()]
            if values:
                rows.append(" | ".join(values))
    return "\n".join(rows)


def extract_plain_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="latin-1", errors="ignore")


def extract_image_document(path: Path) -> str:
    if Image is None:
        raise ValueError("Image support requires Pillow.")
    with Image.open(path) as image:
        return describe_image(image, source_name=path.name)


def extract_image_bytes(image_bytes: bytes, source_name: str) -> str:
    if Image is None:
        return ""
    try:
        with Image.open(io.BytesIO(image_bytes)) as image:
            return describe_image(image, source_name=source_name)
    except UnidentifiedImageError:
        return ""


def describe_image(image, source_name: str) -> str:
    metadata = [f"# Visual asset: {source_name}"]
    metadata.append(f"Format: {getattr(image, 'format', None) or 'unknown'}")
    metadata.append(f"Size: {image.width}x{image.height}")

    frame_count = 1
    if ImageSequence is not None:
        try:
            frame_count = sum(1 for _ in ImageSequence.Iterator(image))
        except Exception:
            frame_count = 1
    if frame_count > 1:
        metadata.append(f"Frames: {frame_count}")

    ocr_text = ocr_image(image)
    if ocr_text:
        metadata.append("")
        metadata.append("# OCR text")
        metadata.append(ocr_text)
    else:
        metadata.append("")
        metadata.append("No OCR text detected.")

    return "\n".join(metadata).strip()


def ocr_image(image) -> str:
    engine = get_ocr_engine()
    if engine is None or np is None:
        return ""

    try:
        rgb = image.convert("RGB")
        result, _ = engine(np.array(rgb))
    except Exception:
        return ""

    if not result:
        return ""

    lines: list[str] = []
    for item in result:
        text = ""
        if isinstance(item, (list, tuple)) and len(item) >= 2:
            candidate = item[1]
            if isinstance(candidate, (list, tuple)) and candidate:
                text = str(candidate[0]).strip()
            else:
                text = str(candidate).strip()
        if text:
            lines.append(text)
    return "\n".join(lines)


def ocr_image_bytes(image_bytes: bytes) -> str:
    if Image is None:
        return ""
    try:
        with Image.open(io.BytesIO(image_bytes)) as image:
            return ocr_image(image)
    except Exception:
        return ""


def get_ocr_engine():
    global _OCR_ENGINE
    if RapidOCR is None:
        return None
    if _OCR_ENGINE is None:
        _OCR_ENGINE = RapidOCR()
    return _OCR_ENGINE


def extract_unknown(path: Path) -> Tuple[str, str]:
    mime_type, _ = mimetypes.guess_type(path.name)
    if mime_type and mime_type.startswith("text"):
        return extract_plain_text(path), f"mime:{mime_type}"
    if mime_type and mime_type.startswith("image"):
        return extract_image_document(path), f"mime:{mime_type}"
    if path.suffix.lower() in IMAGE_EXTENSIONS:
        return extract_image_document(path), "image-ocr"

    raw = path.read_bytes()
    if looks_like_text(raw):
        return raw.decode("utf-8", errors="ignore"), "sniffed-text"

    raise ValueError("Binary or unsupported file type.")


def extract_printable_text(raw: bytes) -> str:
    parts: list[str] = []

    try:
        utf16 = raw.decode("utf-16-le", errors="ignore")
        parts.extend(re.findall(r"[\w][\w\s,\.\-:/\\]{6,}", utf16))
    except Exception:
        pass

    latin = raw.decode("latin-1", errors="ignore")
    parts.extend(re.findall(r"[\w][\w\s,\.\-:/\\]{6,}", latin))

    cleaned = []
    for part in parts:
        normalized = " ".join(part.split())
        if normalized and normalized not in cleaned:
            cleaned.append(normalized)
    return "\n".join(cleaned[:500])


def looks_like_text(raw: bytes) -> bool:
    if not raw:
        return False
    if b"\x00" in raw:
        return False
    sample = raw[:4096]
    printable = sum(1 for byte in sample if 9 <= byte <= 13 or 32 <= byte <= 126)
    ratio = printable / max(len(sample), 1)
    return ratio > 0.75


def normalize_text(text: str) -> str:
    stripped = text.replace("\u0000", "").strip()
    if not stripped:
        return ""
    try:
        parsed = json.loads(stripped)
        if isinstance(parsed, (dict, list)):
            return json.dumps(parsed, indent=2, ensure_ascii=True)
    except Exception:
        pass
    return stripped
