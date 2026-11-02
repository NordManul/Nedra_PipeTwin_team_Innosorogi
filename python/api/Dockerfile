# Сборка из корня репозитория: docker build -f python/api/Dockerfile -t pipetwin-api .
FROM python:3.11-slim
WORKDIR /app
COPY python/requirements.txt python/requirements.txt
RUN pip install --no-cache-dir -r python/requirements.txt
COPY configs configs
COPY fixtures fixtures
COPY python python
RUN mkdir -p results
EXPOSE 8000
CMD ["uvicorn", "python.api.app:app", "--host", "0.0.0.0", "--port", "8000"]
