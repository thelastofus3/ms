FROM python:3.11-slim
WORKDIR /init
RUN pip install --no-cache-dir boto3==1.37.38
COPY init.py .
ENTRYPOINT ["python", "init.py"]
