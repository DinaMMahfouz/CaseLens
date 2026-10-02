FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    CASEQA_ROOT=/workspace

COPY backend/requirements.txt /tmp/requirements.txt
# Build-time downloads only (PyPI + the spaCy model). The running app makes no
# outbound calls except to the configured LLM endpoint.
RUN pip install -r /tmp/requirements.txt \
 && python -m spacy download en_core_web_lg

WORKDIR /workspace/backend
EXPOSE 8000
CMD ["sh", "-c", "python -m scripts.seed --if-empty && exec uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8000"]
