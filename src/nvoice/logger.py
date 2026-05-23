"""
nLogger-compatible JSON Lines logger for Python.
Format: {"ts":"ISO","level":"LEVEL","type":"Category","msg":"text","meta":{},"session":"id"}
"""
import json
import logging
import sys
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from logging.handlers import RotatingFileHandler


_session_id = uuid.uuid4().hex[:8]
_logs_dir = Path(os.environ.get("NVOICE_LOG_DIR", "logs"))
_current_process = "main"


class JsonFormatter(logging.Formatter):
    def format(self, record):
        entry = {
            "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "level": record.levelname,
            "type": getattr(record, "category", _current_process),
            "msg": record.getMessage(),
            "meta": getattr(record, "meta", {}),
            "session": _session_id,
        }
        if record.exc_info and record.exc_info[0]:
            entry["meta"]["traceback"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


_root_logger = None


def init(logs_dir=None, process_name="main"):
    global _root_logger, _current_process
    dir_path = Path(logs_dir) if logs_dir else _logs_dir
    dir_path.mkdir(parents=True, exist_ok=True)
    _current_process = process_name

    logger = logging.getLogger("nvoice")
    logger.setLevel(logging.DEBUG)
    logger.handlers.clear()

    formatter = JsonFormatter()

    console = logging.StreamHandler(sys.stdout)
    console.setLevel(logging.INFO)
    console.setFormatter(formatter)
    logger.addHandler(console)

    file_handler = RotatingFileHandler(
        dir_path / "nvoice.log", maxBytes=10 * 1024 * 1024, backupCount=5
    )
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

    _root_logger = logger
    return logger


def get():
    if _root_logger is None:
        return init()
    return _root_logger


def info(msg, meta=None, category=None):
    get().info(msg, extra={"meta": meta or {}, "category": category or _current_process})


def warn(msg, meta=None, category=None):
    get().warning(msg, extra={"meta": meta or {}, "category": category or _current_process})


def error(msg, meta=None, category=None):
    get().error(msg, extra={"meta": meta or {}, "category": category or _current_process})


def debug(msg, meta=None, category=None):
    get().debug(msg, extra={"meta": meta or {}, "category": category or _current_process})
