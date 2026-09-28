"""Regenerate language-neutral contracts from the validated service models."""
import json
from pathlib import Path

from avatar_service.models import AvatarProfile, Manifest, PoseFrame

root=Path(__file__).resolve().parents[1]/'contracts/avatar'
root.mkdir(parents=True,exist_ok=True)
for name,model in [('profile',AvatarProfile),('manifest',Manifest),('pose',PoseFrame)]:
    schema=model.model_json_schema()
    schema['$schema']='https://json-schema.org/draft/2020-12/schema'
    (root/f'{name}.schema.json').write_text(json.dumps(schema,indent=2)+'\n',encoding='utf-8')
