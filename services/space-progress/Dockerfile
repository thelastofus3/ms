FROM python:3.11-slim
WORKDIR /progress
RUN pip install --no-cache-dir psycopg[binary]==3.2.6 tensorboard==2.18.0 boto3==1.37.38
COPY monitor.py .
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "monitor.py"]
