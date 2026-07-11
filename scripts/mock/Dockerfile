# WoWSP mock backend container.
FROM python:3.13-slim

WORKDIR /app

COPY scripts/mock/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY scripts/mock/src ./src

ENV PYTHONPATH=/app/src
ENV WOWSP_MOCK_PORT=8787
EXPOSE 8787

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8787"]
