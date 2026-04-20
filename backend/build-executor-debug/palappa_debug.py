import asyncio
import json
import os

os.environ["PALAPA_DEBUG_LOGGING"] = "1"

from palappa import main, redact_mapping


def lambda_handler(event, context):
    debug_event = dict(event or {})
    debug_event["debug_mode"] = True
    print("DEBUG_LAMBDA_EVENT " + json.dumps(redact_mapping(debug_event), default=str, sort_keys=True))
    asyncio.run(main(debug_event, context))
