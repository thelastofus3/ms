import json
import os
import boto3
from botocore.exceptions import ClientError

client = boto3.client("s3", endpoint_url=os.environ["ROOM_S3_ENDPOINT"],
                      aws_access_key_id=os.environ["ROOM_S3_ACCESS_KEY"],
                      aws_secret_access_key=os.environ["ROOM_S3_SECRET_KEY"], region_name="us-east-1")
bucket = os.environ.get("ROOM_S3_BUCKET", "rooms")
try:
    client.head_bucket(Bucket=bucket)
except ClientError as error:
    if error.response["ResponseMetadata"]["HTTPStatusCode"] != 404:
        raise
    client.create_bucket(Bucket=bucket)
origins = os.environ.get("ROOM_BROWSER_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173").split(",")
try:
    client.put_bucket_cors(Bucket=bucket, CORSConfiguration={"CORSRules": [{
        "AllowedOrigins": origins, "AllowedMethods": ["GET", "HEAD", "PUT"],
        "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag", "Content-Length"], "MaxAgeSeconds": 3600,
    }]})
except ClientError as error:
    # MinIO uses its global MINIO_API_CORS_ALLOW_ORIGIN configuration.
    if error.response.get("Error", {}).get("Code") != "NotImplemented":
        raise
if os.environ.get("ROOM_S3_PROVIDER", "s3") != "minio":
    client.put_bucket_lifecycle_configuration(Bucket=bucket, LifecycleConfiguration={"Rules": [{
        "ID": "abandon-incomplete-room-uploads", "Status": "Enabled", "Filter": {"Prefix": "inputs/"},
        "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 2},
    }]})
else:
    # MinIO cleans stale multipart uploads internally and does not accept this S3 lifecycle action.
    print("Using MinIO's internal stale multipart upload cleanup")
print(f"Private room bucket ready: {bucket}")
