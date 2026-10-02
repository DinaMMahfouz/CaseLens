"""FastAPI application entry point."""
from __future__ import annotations

import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.db.base import init_engine
from app.jobs.runner import AuditService
from app.llm.providers import LLMProvider
from app.logsafe import configure_logging, log_event
from app.settings import Settings, get_settings


def create_app(settings: Optional[Settings] = None, provider: Optional[LLMProvider] = None) -> FastAPI:
    configure_logging()
    settings = settings or get_settings()       # raises ConfigError -> refuses to start

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        init_engine(settings.database_url)
        svc = AuditService(settings, provider)
        svc.recover_interrupted()
        app.state.service = svc
        log_event("startup", provider=svc.provider.name, model=svc.provider.model,
                  status="redaction_on" if settings.redaction_enabled else "redaction_off_synthetic")
        yield
        svc.pool.shutdown(wait=False, cancel_futures=True)

    app = FastAPI(title="CaseLens worker API", version="1.0.0", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
                       allow_methods=["*"], allow_headers=["*"])

    @app.middleware("http")
    async def access_log(request: Request, call_next):
        t0 = time.monotonic()
        response = await call_next(request)
        # Path only: query strings (e.g. search text) are never logged.
        route = request.scope.get("route")
        log_event("http", method=request.method, path=getattr(route, "path", "unmatched"),
                  status_code=response.status_code, duration_ms=int((time.monotonic() - t0) * 1000))
        return response

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception):
        log_event("unhandled_error", error_kind=type(exc).__name__)
        return JSONResponse({"detail": "internal error"}, status_code=500)

    app.include_router(router)
    return app

