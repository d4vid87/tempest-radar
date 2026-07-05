FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN mkdir -p /data

EXPOSE 5555
HEALTHCHECK --interval=60s --timeout=5s CMD python -c \
    "import urllib.request; urllib.request.urlopen('http://localhost:5555/healthz')"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5555"]
