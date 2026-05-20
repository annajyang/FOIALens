import asyncio
import os

import boto3


def _s3():
    return boto3.client(
        's3',
        region_name=os.environ.get('DO_SPACES_REGION', 'nyc3'),
        endpoint_url=os.environ['DO_SPACES_ENDPOINT'],
        aws_access_key_id=os.environ['DO_SPACES_KEY'],
        aws_secret_access_key=os.environ['DO_SPACES_SECRET'],
    )


async def upload_bytes(content: bytes, key: str, content_type: str = 'application/octet-stream') -> None:
    bucket = os.environ['DO_SPACES_BUCKET']
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None,
        lambda: _s3().put_object(Bucket=bucket, Key=key, Body=content, ContentType=content_type),
    )


def presigned_url(key: str, expires: int = 3600) -> str:
    return _s3().generate_presigned_url(
        'get_object',
        Params={'Bucket': os.environ['DO_SPACES_BUCKET'], 'Key': key},
        ExpiresIn=expires,
    )


async def delete_object(key: str) -> None:
    bucket = os.environ['DO_SPACES_BUCKET']
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, lambda: _s3().delete_object(Bucket=bucket, Key=key))


async def delete_folder(prefix: str) -> None:
    """Delete all objects under a prefix (e.g. 'documents/{workspace_id}/')."""
    bucket = os.environ['DO_SPACES_BUCKET']
    loop = asyncio.get_event_loop()

    def _delete_all():
        paginator = _s3().get_paginator('list_objects_v2')
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            objects = [{'Key': o['Key']} for o in page.get('Contents', [])]
            if objects:
                _s3().delete_objects(Bucket=bucket, Delete={'Objects': objects})

    await loop.run_in_executor(None, _delete_all)
