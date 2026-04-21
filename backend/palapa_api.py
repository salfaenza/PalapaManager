import base64
import json
import os
import re
import uuid
import urllib.parse
from datetime import datetime, timedelta

import boto3
import pytz
import requests
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")
USERS_TABLE_NAME = os.environ.get("PALAPA_USERS_TABLE", "palapa-users")
PROFILES_TABLE_NAME = os.environ.get("PALAPA_PROFILES_TABLE", "palapa-profiles")
BOOKING_RESULTS_TABLE_NAME = os.environ.get("PALAPA_BOOKING_RESULTS_TABLE", "palapa-booking-results")
users_table = dynamodb.Table(USERS_TABLE_NAME)
profiles_table = dynamodb.Table(PROFILES_TABLE_NAME)
booking_results_table = dynamodb.Table(BOOKING_RESULTS_TABLE_NAME)

scheduler = boto3.client("scheduler")
lambda_client = boto3.client("lambda")

BASE_URL = "https://marriottarubasurfclub.ipoolside.com"
SEATING_URL = f"{BASE_URL}/seating/next-day-reservation"
TARGET_LAMBDA_ARN = os.environ.get(
    "PALAPA_TARGET_LAMBDA_ARN",
    "arn:aws:lambda:us-east-1:561031966991:function:palapa-executor",
)
DEBUG_TARGET_LAMBDA_ARN = os.environ.get(
    "PALAPA_DEBUG_TARGET_LAMBDA_ARN",
    "arn:aws:lambda:us-east-1:561031966991:function:palapa-executor-debug",
)
INVOKE_ROLE_ARN = os.environ.get(
    "PALAPA_INVOKE_ROLE_ARN",
    "arn:aws:iam::561031966991:role/palapa-backend-SchedulerInvokeRole-KZM8hLC4EWBV",
)
STANDARD_LOG_GROUP = "/aws/lambda/palapa-executor"
DEBUG_LOG_GROUP = "/aws/lambda/palapa-executor-debug"
LOG_GROUPS = [
    {"log_group": STANDARD_LOG_GROUP, "function_mode": "standard"},
    {"log_group": DEBUG_LOG_GROUP, "function_mode": "debug"},
]

ARUBA_TZ = pytz.timezone("America/Aruba")
SCHEDULE_GROUP = os.environ.get("PALAPA_SCHEDULE_GROUP", "default")

# Default opening times (Aruba time) if palapa metadata is unavailable.
DEFAULT_ADVANCE_BOOKING_TIME = "17:30"
DEFAULT_SAME_DAY_BOOKING_TIME = "07:00"

# Fire the executor Lambda this many seconds before the booking window opens,
# giving it time to initialize the HTTP session before the window opens.
# EventBridge delivery latency can be 20-30+ seconds, so 60s gives a safe margin.
LEAD_TIME_SECONDS = 60

PROFILE_FIELDS = {"first", "last", "name", "room", "email", "phone", "notification_phone", "sms_enabled"}


# ---------------------------------------------------------------------------
# Lambda entrypoint (thin router -> helpers)
# ---------------------------------------------------------------------------

def lambda_handler(event, context):
    print("Event received:", json.dumps(event))

    path = event.get("rawPath", "")
    method = event.get("requestContext", {}).get("http", {}).get("method")

    if method == "OPTIONS":
        return cors_response(200, {})

    if path == "/auth-check":
        return handle_auth_check(event)

    email = claim_email(event)
    if not email:
        return cors_response(403, {"error": "Missing email in token"})
    role = get_user_role(email)
    if not role:
        return cors_response(403, {"error": "Unauthorized user"})

    # Users
    if method == "POST" and path == "/users":
        return handle_create_user(event, role)
    if method == "GET" and path == "/users":
        return handle_list_users(role)
    if method == "DELETE" and path.startswith("/users/"):
        return handle_delete_user(path, role)

    # Profile (legacy single-profile)
    if method == "GET" and path == "/profile":
        return handle_get_profile(email)
    if method == "PATCH" and path == "/profile":
        return handle_patch_profile(event, email)

    # Profiles (multi-profile)
    if method == "GET" and path == "/profiles":
        return handle_list_profiles(email)
    if method == "POST" and path == "/profiles":
        return handle_create_profile(event, email)
    if method == "PATCH" and path.startswith("/profiles/"):
        profile_id = path.split("/")[-1]
        return handle_update_profile(event, email, profile_id)
    if method == "DELETE" and path.startswith("/profiles/"):
        profile_id = path.split("/")[-1]
        return handle_delete_profile(email, profile_id)

    # Logs
    if method == "GET" and path == "/logs":
        return handle_list_logs(role)
    if method == "GET" and path.startswith("/logs/"):
        return handle_get_log_stream(event, path, role)

    # Palapas/availability
    if method == "GET" and path == "/palapas":
        return handle_get_palapas(event)

    # Booking results (completed bookings from iPoolside)
    if method == "GET" and path == "/booking-results":
        return handle_list_booking_results(email, role)
    if method == "POST" and re.match(r"^/booking-results/[^/]+/cancel$", path):
        result_id = path.split("/")[2]
        return handle_cancel_booking_result(result_id, email, role)

    # Bookings
    if method == "GET" and path == "/bookings":
        return get_all_bookings_from_schedules(role, email)
    if method == "POST" and path == "/bookings":
        return handle_create_booking(event, email)
    if method == "POST" and path == "/bookings/now":
        return handle_book_now(event, email)
    if method == "PUT" and path.startswith("/bookings/"):
        schedule_name = path.split("/")[-1]
        return handle_update_booking(event, email, schedule_name)
    if method == "DELETE" and path.startswith("/bookings/"):
        schedule_name = path.split("/")[-1]
        return handle_delete_booking(schedule_name)

    return cors_response(405, {"error": "Method not allowed"})


# ---------------------------------------------------------------------------
# Auth + user handlers
# ---------------------------------------------------------------------------

def handle_auth_check(event):
    email = claim_email(event)
    if not email:
        return cors_response(403, {"error": "Missing email in token"})
    role = get_user_role(email)
    if not role:
        return cors_response(403, {"error": "Unauthorized user"})
    return cors_response(200, {"email": email, "role": role})


def handle_create_user(event, role):
    if role != "admin":
        return cors_response(403, {"error": "Only admins can add users"})
    try:
        user_data = json.loads(event["body"])
        new_email = user_data.get("email")
        new_role = user_data.get("role", "user")
        if not new_email:
            return cors_response(400, {"error": "Missing email"})
        users_table.put_item(Item={"email": new_email, "role": new_role})
        return cors_response(200, {"message": f"User {new_email} added with role '{new_role}'"})
    except Exception as e:
        print("Error adding user:", str(e))
        return cors_response(500, {"error": str(e)})


def handle_list_users(role):
    if role != "admin":
        return cors_response(403, {"error": "Only admins can view users"})
    try:
        response = users_table.scan()
        return cors_response(200, response.get("Items", []))
    except Exception as e:
        print("Error listing users:", str(e))
        return cors_response(500, {"error": str(e)})


def handle_delete_user(path, role):
    if role != "admin":
        return cors_response(403, {"error": "Only admins can delete users"})
    email_to_delete = path.split("/")[-1]
    if not email_to_delete:
        return cors_response(400, {"error": "Missing email to delete"})
    try:
        users_table.delete_item(Key={"email": email_to_delete})
        return cors_response(200, {"message": f"User {email_to_delete} deleted"})
    except Exception as e:
        print("Error deleting user:", str(e))
        return cors_response(500, {"error": str(e)})


# ---------------------------------------------------------------------------
# Profile handlers
# ---------------------------------------------------------------------------

def handle_get_profile(email):
    try:
        item = get_profile_item(email)
        return cors_response(200, item or empty_profile(email))
    except Exception as e:
        print("Error fetching profile:", str(e))
        return cors_response(500, {"error": str(e)})


def handle_patch_profile(event, email):
    try:
        body = json.loads(event.get("body") or "{}")
    except ValueError:
        return cors_response(400, {"error": "Invalid JSON body"})

    updates = {}
    for key, value in body.items():
        if key not in PROFILE_FIELDS:
            continue
        if isinstance(value, bool):
            updates[key] = value
        elif isinstance(value, str):
            updates[key] = value.strip()
        elif value is None:
            updates[key] = ""

    if not updates:
        return cors_response(400, {"error": "No valid profile fields supplied"})

    first = updates.get("first")
    last = updates.get("last")
    if ("first" in updates or "last" in updates) and "name" not in updates:
        existing = get_profile_item(email) or {}
        first_val = first if first is not None else existing.get("first", "")
        last_val = last if last is not None else existing.get("last", "")
        updates["name"] = f"{first_val} {last_val}".strip()

    try:
        updated = upsert_profile_fields(email, updates)
        return cors_response(200, updated)
    except Exception as e:
        print("Error saving profile:", str(e))
        return cors_response(500, {"error": str(e)})


def get_profile_item(email):
    try:
        res = profiles_table.get_item(Key={"email": email})
        return res.get("Item")
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "ResourceNotFoundException":
            return None
        raise


def empty_profile(email):
    return {"email": email, "first": "", "last": "", "name": "", "room": "", "phone": "", "notification_phone": "", "sms_enabled": False}


def upsert_profile_fields(email, updates):
    names = {}
    values = {}
    set_fragments = []
    for idx, (key, value) in enumerate(updates.items()):
        placeholder = f"#f{idx}"
        value_key = f":v{idx}"
        names[placeholder] = key
        values[value_key] = value
        set_fragments.append(f"{placeholder} = {value_key}")
    names["#updated_at"] = "updated_at"
    values[":updated_at"] = datetime.utcnow().isoformat()
    set_fragments.append("#updated_at = :updated_at")

    profiles_table.update_item(
        Key={"email": email},
        UpdateExpression="SET " + ", ".join(set_fragments),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )
    merged = get_profile_item(email) or {"email": email}
    return merged


# ---------------------------------------------------------------------------
# Multi-profile handlers
# ---------------------------------------------------------------------------

def handle_list_profiles(owner_email):
    """Return all profiles owned by this user."""
    try:
        result = profiles_table.scan(
            FilterExpression="owner_email = :oe",
            ExpressionAttributeValues={":oe": owner_email},
        )
        items = result.get("Items", [])
        # Also include the legacy profile (keyed by owner email, no owner_email attr)
        legacy = get_profile_item(owner_email)
        if legacy and not legacy.get("owner_email"):
            legacy["id"] = legacy["email"]
            legacy["owner_email"] = owner_email
            # Migrate it: stamp owner_email so it shows up in scans next time
            try:
                profiles_table.update_item(
                    Key={"email": owner_email},
                    UpdateExpression="SET #oe = :oe, #pid = :pid",
                    ExpressionAttributeNames={"#oe": "owner_email", "#pid": "id"},
                    ExpressionAttributeValues={":oe": owner_email, ":pid": owner_email},
                )
            except Exception:
                pass
            # Dedupe: only add if not already in scan results
            if not any(i.get("email") == owner_email for i in items):
                items.append(legacy)
        # Ensure every item has an id field
        for item in items:
            if "id" not in item:
                item["id"] = item.get("email", "")
        return cors_response(200, items)
    except Exception as e:
        print("Error listing profiles:", str(e))
        return cors_response(500, {"error": str(e)})


def handle_create_profile(event, owner_email):
    """Create a new profile. Email must be unique across all profiles."""
    try:
        body = json.loads(event.get("body") or "{}")
    except ValueError:
        return cors_response(400, {"error": "Invalid JSON body"})

    profile_email = (body.get("email") or "").strip().lower()
    if not profile_email:
        return cors_response(400, {"error": "Email is required"})

    # Check for duplicate email
    existing = get_profile_item(profile_email)
    if existing:
        return cors_response(409, {"error": f"A profile with email {profile_email} already exists"})

    first = (body.get("first") or "").strip()
    last = (body.get("last") or "").strip()
    name = f"{first} {last}".strip()
    profile_id = profile_email  # use email as the ID (it's the DynamoDB key)

    sms_enabled = body.get("sms_enabled")
    if not isinstance(sms_enabled, bool):
        sms_enabled = False

    item = {
        "email": profile_email,
        "id": profile_id,
        "owner_email": owner_email,
        "first": first,
        "last": last,
        "name": name,
        "room": (body.get("room") or "").strip(),
        "phone": (body.get("phone") or "").strip(),
        "notification_phone": (body.get("notification_phone") or "").strip(),
        "sms_enabled": sms_enabled,
        "created_at": datetime.utcnow().isoformat(),
    }
    profiles_table.put_item(Item=item)
    return cors_response(200, item)


def handle_update_profile(event, owner_email, profile_id):
    """Update a profile. Only the owner can update their profiles."""
    try:
        body = json.loads(event.get("body") or "{}")
    except ValueError:
        return cors_response(400, {"error": "Invalid JSON body"})

    profile_email = urllib.parse.unquote(profile_id)
    existing = get_profile_item(profile_email)
    if not existing:
        return cors_response(404, {"error": "Profile not found"})
    if existing.get("owner_email", existing.get("email")) != owner_email and existing.get("email") != owner_email:
        return cors_response(403, {"error": "Not your profile"})

    updates = {}
    for key in ("first", "last", "room", "phone", "notification_phone"):
        if key in body and isinstance(body[key], str):
            updates[key] = body[key].strip()
    if "sms_enabled" in body and isinstance(body["sms_enabled"], bool):
        updates["sms_enabled"] = body["sms_enabled"]

    # Handle email change with uniqueness check
    new_email = (body.get("email") or "").strip().lower()
    if new_email and new_email != profile_email:
        dup = get_profile_item(new_email)
        if dup:
            return cors_response(409, {"error": f"A profile with email {new_email} already exists"})
        # Need to delete old item and create new one (can't change DynamoDB partition key)
        new_item = dict(existing)
        new_item.update(updates)
        new_item["email"] = new_email
        new_item["id"] = new_email
        first = updates.get("first", existing.get("first", ""))
        last = updates.get("last", existing.get("last", ""))
        new_item["name"] = f"{first} {last}".strip()
        new_item["updated_at"] = datetime.utcnow().isoformat()
        profiles_table.put_item(Item=new_item)
        profiles_table.delete_item(Key={"email": profile_email})
        return cors_response(200, new_item)

    if not updates:
        return cors_response(400, {"error": "No valid fields to update"})

    first = updates.get("first", existing.get("first", ""))
    last = updates.get("last", existing.get("last", ""))
    updates["name"] = f"{first} {last}".strip()

    updated = upsert_profile_fields(profile_email, updates)
    updated["id"] = updated.get("id", profile_email)
    return cors_response(200, updated)


def handle_delete_profile(owner_email, profile_id):
    """Delete a profile. Cannot delete the last one."""
    profile_email = urllib.parse.unquote(profile_id)
    existing = get_profile_item(profile_email)
    if not existing:
        return cors_response(404, {"error": "Profile not found"})
    if existing.get("owner_email", existing.get("email")) != owner_email and existing.get("email") != owner_email:
        return cors_response(403, {"error": "Not your profile"})

    # Count how many profiles this user owns
    result = profiles_table.scan(
        FilterExpression="owner_email = :oe",
        ExpressionAttributeValues={":oe": owner_email},
        Select="COUNT",
    )
    count = result.get("Count", 0)
    # Also count the legacy profile
    legacy = get_profile_item(owner_email)
    if legacy and not legacy.get("owner_email"):
        count += 1
    if count <= 1:
        return cors_response(400, {"error": "Cannot delete your last profile"})

    profiles_table.delete_item(Key={"email": profile_email})
    return cors_response(200, {"message": "Profile deleted"})


def pick_available_profile(owner_email, book_date, exclude_profile_id=None):
    """Return a profile not already assigned to a booking on the given date."""
    # Get all profiles for this user
    result = profiles_table.scan(
        FilterExpression="owner_email = :oe",
        ExpressionAttributeValues={":oe": owner_email},
    )
    all_profiles = result.get("Items", [])
    legacy = get_profile_item(owner_email)
    if legacy and not any(p.get("email") == owner_email for p in all_profiles):
        all_profiles.append(legacy)

    if not all_profiles:
        return None

    # Find which profile emails are already used on this date
    used_emails = set()
    try:
        response = scheduler.list_schedules(GroupName=SCHEDULE_GROUP)
        for s in response.get("Schedules", []):
            try:
                details = scheduler.get_schedule(Name=s["Name"], GroupName=SCHEDULE_GROUP)
                payload = json.loads(details["Target"]["Input"])
                if payload.get("book_date") == book_date and payload.get("profile_email"):
                    used_emails.add(payload["profile_email"])
            except Exception:
                continue
    except Exception:
        pass

    if exclude_profile_id:
        used_emails.discard(exclude_profile_id)

    for prof in all_profiles:
        if prof.get("email") not in used_emails:
            return prof
    return None


# ---------------------------------------------------------------------------
# Logs handlers
# ---------------------------------------------------------------------------

def handle_list_logs(role):
    if role != "admin":
        return cors_response(403, {"error": "Only admins can view logs"})
    try:
        logs_client = boto3.client("logs")
        now = datetime.utcnow()
        two_days_ago = int((now - timedelta(days=2)).timestamp() * 1000)
        schedule_latest = {}
        for group in LOG_GROUPS:
            log_group = group["log_group"]
            function_mode = group["function_mode"]
            try:
                streams_response = logs_client.describe_log_streams(
                    logGroupName=log_group,
                    orderBy="LastEventTime",
                    descending=True,
                    limit=50,
                )
            except ClientError as e:
                if e.response.get("Error", {}).get("Code") == "ResourceNotFoundException":
                    continue
                raise

            for stream in streams_response.get("logStreams", []):
                stream_name = stream["logStreamName"]
                last_event = stream.get("lastEventTimestamp", 0)
                if last_event < two_days_ago:
                    continue
                events = logs_client.get_log_events(
                    logGroupName=log_group,
                    logStreamName=stream_name,
                    limit=100,
                    startFromHead=True,
                ).get("events", [])
                if not events:
                    continue
                messages = [e["message"].strip() for e in events if e.get("message")]
                if not messages:
                    continue
                first_5 = messages[:5]
                last_5 = messages[-5:] if len(messages) > 5 else messages
                limited_messages = first_5 + last_5 if len(messages) > 10 else messages
                schedule_name = extract_schedule_name(limited_messages) or "unknown"
                latest_key = f"{log_group}:{schedule_name}:{stream_name}"
                if latest_key not in schedule_latest:
                    schedule_latest[latest_key] = {
                        "streamName": stream_name,
                        "logGroup": log_group,
                        "functionMode": function_mode,
                        "lastEventTime": last_event,
                        "messages": limited_messages,
                    }
        return cors_response(200, {
            "stream_count": len(schedule_latest),
            "streams": list(schedule_latest.values()),
        })
    except Exception as e:
        print("Failed to get logs:", str(e))
        return cors_response(500, {"error": str(e)})


def handle_get_log_stream(event, path, role):
    if role != "admin":
        return cors_response(403, {"error": "Only admins can view logs"})
    stream_name = ""
    try:
        stream_name_encoded = path[len("/logs/"):]
        stream_name = urllib.parse.unquote(stream_name_encoded)
        log_group = get_requested_log_group(event)
        logs_client = boto3.client("logs")
        events = logs_client.get_log_events(
            logGroupName=log_group,
            logStreamName=stream_name,
            limit=10000,
            startFromHead=True,
        ).get("events", [])
        messages = [e["message"].strip() for e in events if e.get("message")]
        return cors_response(200, {
            "streamName": stream_name,
            "logGroup": log_group,
            "messageCount": len(messages),
            "messages": messages,
        })
    except Exception as e:
        print(f"Error fetching full logs for {stream_name}:", str(e))
        return cors_response(500, {"error": str(e)})


# ---------------------------------------------------------------------------
# Palapa availability handler
# ---------------------------------------------------------------------------

def handle_get_palapas(event):
    try:
        book_date = get_query_param(event, "book_date") or default_book_date()
        palapas = fetch_palapa_options(book_date)
        locks = internal_locks_for_date(book_date)
        merged = apply_internal_locks(palapas, locks)
        return cors_response(200, {
            "book_date": book_date,
            "palapas": merged,
        })
    except Exception as e:
        print("Error fetching palapas:", str(e))
        return cors_response(500, {"error": str(e)})


def apply_internal_locks(palapas, locks):
    """Return a new list where huts locked internally are marked unavailable."""
    result = []
    for palapa in palapas:
        copy = dict(palapa)
        lock = locks.get(str(palapa.get("name")))
        if lock:
            copy["available"] = False
            copy["internal_lock"] = True
            copy["lock_reason"] = lock.get("reason", "Already scheduled by another user")
            if not copy.get("status_label") or copy.get("status_label") in {"Available", "Unknown"}:
                copy["status_label"] = "Held (app)"
        result.append(copy)
    return result


def internal_locks_for_date(book_date):
    """Return a dict mapping hut_number -> {reason} for huts already scheduled/held
    on a given book_date across the app's schedules."""
    locks = {}
    try:
        response = scheduler.list_schedules(GroupName=SCHEDULE_GROUP)
        for s in response.get("Schedules", []):
            try:
                details = scheduler.get_schedule(Name=s["Name"], GroupName=SCHEDULE_GROUP)
                payload = json.loads(details["Target"]["Input"])
            except Exception:
                continue
            sched_date = payload.get("book_date")
            if sched_date and sched_date != book_date:
                continue
            # Legacy rows without book_date: only count as conflict if no book_date yet
            # i.e., treat them as legacy/global; safer is to skip them entirely here so
            # they do not block a future date. They remain editable via old flow.
            if not sched_date:
                continue
            reason = f"Scheduled by {payload.get('creator_email', 'another user')}"
            for hut in hut_choices_from_payload(payload):
                locks.setdefault(str(hut), {"reason": reason})
    except Exception as e:
        print("Error listing schedules for locks:", str(e))
    return locks


def hut_choices_from_payload(payload):
    """Extract the ordered list of hut choices from a schedule payload,
    falling back to legacy single hut_number if necessary."""
    choices = payload.get("hut_choices")
    if isinstance(choices, list) and choices:
        return [str(c) for c in choices if c]
    legacy = payload.get("hut_number")
    return [str(legacy)] if legacy else []


# ---------------------------------------------------------------------------
# Booking handlers
# ---------------------------------------------------------------------------

def handle_create_booking(event, email):
    try:
        data = json.loads(event["body"])
    except ValueError:
        return cors_response(400, {"error": "Invalid JSON body"})

    debug_mode = parse_bool(data.get("debug_mode"))

    # Multi-day support: accept book_dates array or single book_date
    book_dates = data.get("book_dates") or []
    if not book_dates:
        single = (data.get("book_date") or default_book_date()).strip()
        book_dates = [single]
    for bd in book_dates:
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(bd).strip()):
            return cors_response(400, {"error": f"Invalid date format: {bd}"})
    book_dates = [str(bd).strip() for bd in book_dates]

    hut_choices = normalize_hut_choices(data.get("hut_choices") or (
        [data.get("hut_number")] if data.get("hut_number") else []
    ))
    if not hut_choices:
        return cors_response(400, {"error": "At least one hut must be chosen"})

    # Check availability against the first date
    first_date = book_dates[0]
    palapas = fetch_palapa_options(first_date)

    # Validate all hut choices share the same booking window time
    window_err = validate_same_booking_window(palapas, hut_choices)
    if window_err:
        return cors_response(400, window_err)

    locks = internal_locks_for_date(first_date)
    selected, unavailable = select_first_available_choice(palapas, locks, hut_choices)
    availability_warnings = []
    if selected is None:
        # Soft availability — proceed with metadata from first hut
        meta = find_palapa_metadata(palapas, hut_choices)
        if meta is None:
            return cors_response(400, {"error": "None of the selected huts exist"})
        selected = meta
        availability_warnings = unavailable

    primary = hut_choices[0]
    booking_time = selected.get("booking_time", DEFAULT_ADVANCE_BOOKING_TIME)
    palapatype = selected.get("palapatype_name", "")

    created = []
    errors = []
    for book_date in book_dates:
        # Auto-assign a profile for this date
        prof = pick_available_profile(email, book_date)
        if not prof:
            errors.append({
                "book_date": book_date,
                "error": "No available profile for this date",
            })
            continue

        first = prof.get("first", "")
        last = prof.get("last", "")
        prof_name = prof.get("name") or f"{first} {last}".strip()

        booking_id = str(uuid.uuid4())
        schedule_name = build_schedule_name(last, primary, booking_time, booking_id)

        payload = {
            "id": booking_id,
            "schedule_name": schedule_name,
            "book_date": book_date,
            "hut_choices": hut_choices,
            "hut_number": primary,
            "palapatype_name": palapatype,
            "booking_time": booking_time,
            "profile_email": prof.get("email", email),
            "profile_id": prof.get("id", prof.get("email", email)),
            "creator_email": email,
            "first": first,
            "last": last,
            "name": prof_name,
            "email": prof.get("email", email),
            "phone": prof.get("phone", ""),
            "room": prof.get("room", ""),
            "created_at": datetime.utcnow().isoformat(),
            "debug_mode": debug_mode,
        }

        try:
            schedule_one_time_job(schedule_name, payload, book_date, booking_time, palapatype, debug_mode)
            created.append({
                "book_date": book_date,
                "id": booking_id,
                "schedule_name": schedule_name,
                "profile_name": prof_name,
            })
        except Exception as e:
            print(f"Error scheduling job for {book_date}:", str(e))
            errors.append({"book_date": book_date, "error": str(e)})

    if not created:
        return cors_response(500 if errors else 409, {
            "error": "No bookings could be scheduled",
            "errors": errors,
        })

    resp = {
        "message": f"{len(created)} booking(s) scheduled",
        "booking_time": booking_time,
        "book_dates": [c["book_date"] for c in created],
        "hut_choices": hut_choices,
        "debug_mode": debug_mode,
        "created": created,
        "errors": errors,
    }
    if availability_warnings:
        resp["availability_warnings"] = availability_warnings
    return cors_response(200, resp)


def handle_update_booking(event, email, schedule_name):
    try:
        data = json.loads(event["body"])
    except ValueError:
        return cors_response(400, {"error": "Invalid JSON body"})
    try:
        current_schedule = scheduler.get_schedule(Name=schedule_name, GroupName=SCHEDULE_GROUP)
        current_payload = json.loads(current_schedule["Target"]["Input"])
    except Exception as e:
        print(f"Error fetching existing schedule {schedule_name}:", str(e))
        current_payload = {}

    # Handle profile change via profile_id
    new_profile_id = data.get("profile_id")
    if new_profile_id:
        profile_email = urllib.parse.unquote(new_profile_id)
        prof = get_profile_item(profile_email)
        if prof:
            current_payload["profile_email"] = prof.get("email", profile_email)
            current_payload["profile_id"] = prof.get("id", profile_email)
            current_payload["first"] = prof.get("first", "")
            current_payload["last"] = prof.get("last", "")
            current_payload["name"] = prof.get("name") or f"{prof.get('first', '')} {prof.get('last', '')}".strip()
            current_payload["email"] = prof.get("email", profile_email)
            current_payload["phone"] = prof.get("phone", "")
            current_payload["room"] = prof.get("room", "")
            # If only profile_id was sent, skip the rest of the update logic
            if len(data) == 1:
                try:
                    scheduler.delete_schedule(Name=schedule_name, GroupName=SCHEDULE_GROUP)
                except ClientError:
                    pass
                book_date = current_payload.get("book_date", default_book_date())
                booking_time = current_payload.get("booking_time", DEFAULT_ADVANCE_BOOKING_TIME)
                palapatype = current_payload.get("palapatype_name", "")
                debug_mode = parse_bool(current_payload.get("debug_mode", False))
                try:
                    schedule_one_time_job(schedule_name, current_payload, book_date, booking_time, palapatype, debug_mode)
                except Exception as exc:
                    return cors_response(500, {"error": str(exc)})
                return cors_response(200, {"message": f"Profile updated for {schedule_name}"})

    try:
        parsed = parse_booking_input(data, email, existing=current_payload)
    except ValueError as e:
        return cors_response(400, {"error": str(e)})

    book_date = parsed["book_date"]
    hut_choices = parsed["hut_choices"]
    debug_mode = parse_bool(data.get("debug_mode", current_payload.get("debug_mode", False)))

    palapas = fetch_palapa_options(book_date)

    # Validate all hut choices share the same booking window time
    window_err = validate_same_booking_window(palapas, hut_choices)
    if window_err:
        return cors_response(400, window_err)

    locks = internal_locks_for_date(book_date)
    # Exclude this schedule's own lock when re-checking
    for hut in hut_choices_from_payload(current_payload):
        locks.pop(str(hut), None)
    selected, unavailable = select_first_available_choice(palapas, locks, hut_choices)
    availability_warnings = []
    if selected is None:
        meta = find_palapa_metadata(palapas, hut_choices)
        if meta is None:
            return cors_response(400, {"error": "None of the selected huts exist"})
        selected = meta
        availability_warnings = unavailable
    primary = hut_choices[0]
    booking_time = selected.get("booking_time", DEFAULT_ADVANCE_BOOKING_TIME)
    palapatype = selected.get("palapatype_name", "")

    try:
        scheduler.delete_schedule(Name=schedule_name, GroupName=SCHEDULE_GROUP)
    except ClientError as e:
        print(f"Could not delete old schedule {schedule_name}:", str(e))

    payload = {
        "id": current_payload.get("id", str(uuid.uuid4())),
        "schedule_name": schedule_name,
        "created_at": current_payload.get("created_at", datetime.utcnow().isoformat()),
        "book_date": book_date,
        "hut_choices": hut_choices,
        "hut_number": primary,
        "palapatype_name": palapatype,
        "booking_time": booking_time,
        "profile_email": current_payload.get("profile_email", email),
        "profile_id": current_payload.get("profile_id", current_payload.get("profile_email", email)),
        "creator_email": current_payload.get("creator_email", email),
        "first": parsed.get("first", ""),
        "last": parsed.get("last", ""),
        "name": parsed.get("name", ""),
        "email": parsed.get("email", email),
        "phone": parsed.get("phone", ""),
        "room": parsed.get("room", ""),
        "debug_mode": debug_mode,
    }

    try:
        schedule_one_time_job(schedule_name, payload, book_date, booking_time, palapatype, debug_mode)
    except Exception as e:
        print(f"Error rescheduling {schedule_name}:", str(e))
        return cors_response(500, {"error": str(e)})

    resp = {
        "message": f"Booking {schedule_name} updated",
        "book_date": book_date,
        "hut_choices": hut_choices,
        "debug_mode": debug_mode,
    }
    if availability_warnings:
        resp["availability_warnings"] = availability_warnings
    return cors_response(200, resp)


def handle_delete_booking(schedule_name):
    try:
        scheduler.delete_schedule(Name=schedule_name, GroupName=SCHEDULE_GROUP)
        return cors_response(200, {"message": f"Schedule '{schedule_name}' deleted."})
    except ClientError as e:
        print(f"Error deleting schedule {schedule_name}: {e}")
        return cors_response(500, {"error": str(e)})


def handle_book_now(event, email):
    try:
        data = json.loads(event.get("body") or "{}")
    except ValueError:
        return cors_response(400, {"error": "Invalid JSON body"})

    book_date = data.get("book_date") or default_book_date()
    hut_choices = normalize_hut_choices(data.get("hut_choices") or (
        [data.get("hut_number")] if data.get("hut_number") else []
    ))
    if not hut_choices:
        return cors_response(400, {"error": "hut_choices is required"})
    debug_mode = parse_bool(data.get("debug_mode"))

    palapas = fetch_palapa_options(book_date)

    # Validate all hut choices share the same booking window time
    window_err = validate_same_booking_window(palapas, hut_choices)
    if window_err:
        return cors_response(400, window_err)

    locks = internal_locks_for_date(book_date)
    selected, unavailable = select_first_available_choice(palapas, locks, hut_choices)
    if selected is None:
        return cors_response(409, {
            "error": "None of the selected huts are available for that date",
            "unavailable": unavailable,
        })

    palapatype = selected.get("palapatype_name", "")
    booking_time = selected.get("booking_time", DEFAULT_ADVANCE_BOOKING_TIME)
    allowed, window_start = check_book_now_allowed(book_date, palapatype, booking_time)
    if not allowed:
        return cors_response(403, {
            "error": "Too early to book now. Try again later.",
            "allowed_after": window_start.isoformat(),
            "allowed_after_local": window_start.strftime("%Y-%m-%d %H:%M %Z"),
        })

    # Auto-assign a profile
    prof = pick_available_profile(email, book_date)
    if not prof:
        return cors_response(409, {
            "error": "No available profiles. Each profile can only be used once per day. Add another profile."
        })

    missing = [f for f in ("first", "last", "room", "email", "phone") if not (prof.get(f) or "").strip()]
    if missing:
        return cors_response(400, {
            "error": "Profile is incomplete; fill it in before booking now",
            "missing_fields": missing,
        })

    first = prof.get("first", "")
    last = prof.get("last", "")
    prof_name = prof.get("name") or f"{first} {last}".strip()

    booking_id = str(uuid.uuid4())
    payload = {
        "id": booking_id,
        "book_date": book_date,
        "hut_choices": hut_choices,
        "hut_number": hut_choices[0],
        "palapatype_name": palapatype,
        "booking_time": booking_time,
        "profile_email": prof.get("email", email),
        "profile_id": prof.get("id", prof.get("email", email)),
        "creator_email": email,
        "first": first,
        "last": last,
        "name": prof_name,
        "email": prof.get("email", email),
        "phone": prof.get("phone", ""),
        "room": prof.get("room", ""),
        "debug_mode": debug_mode,
        "invocation_source": "book_now",
    }

    target_arn = DEBUG_TARGET_LAMBDA_ARN if debug_mode else TARGET_LAMBDA_ARN
    try:
        lambda_client.invoke(
            FunctionName=target_arn,
            InvocationType="Event",
            Payload=json.dumps(payload).encode("utf-8"),
        )
    except Exception as e:
        print("Error invoking booking lambda:", str(e))
        return cors_response(500, {"error": str(e)})

    return cors_response(202, {
        "message": "Booking triggered",
        "id": booking_id,
        "book_date": book_date,
        "hut_choices": hut_choices,
        "profile_name": prof_name,
        "debug_mode": debug_mode,
    })


# ---------------------------------------------------------------------------
# Booking results handlers (completed iPoolside bookings)
# ---------------------------------------------------------------------------

def handle_list_booking_results(email, role):
    """List completed booking results. Admins see all; users see their own."""
    try:
        result = booking_results_table.scan()
        items = result.get("Items", [])
        if role != "admin":
            items = [i for i in items if i.get("creator_email") == email]
        # Sort by created_at descending
        items.sort(key=lambda x: x.get("created_at", ""), reverse=True)
        return cors_response(200, items)
    except Exception as e:
        print("Error listing booking results:", str(e))
        return cors_response(500, {"error": str(e)})


def handle_cancel_booking_result(result_id, email, role):
    """Cancel a booking on iPoolside by proxying through our backend."""
    # Look up the booking result
    try:
        res = booking_results_table.get_item(Key={"id": result_id})
        item = res.get("Item")
    except Exception as e:
        print(f"Error fetching booking result {result_id}:", str(e))
        return cors_response(500, {"error": str(e)})

    if not item:
        return cors_response(404, {"error": "Booking result not found"})

    # Authorization check
    if role != "admin" and item.get("creator_email") != email:
        return cors_response(403, {"error": "Not your booking"})

    if item.get("status") == "cancelled":
        return cors_response(400, {"error": "Booking already cancelled"})

    ipoolside_booking_id = item.get("ipoolside_booking_id")
    if not ipoolside_booking_id:
        return cors_response(400, {"error": "No iPoolside booking ID stored for this booking"})

    # Build login token from profile email + slot1_transaction_at
    profile_email = item.get("profile_email", "")
    slot1_txn_at = item.get("slot1_transaction_at", "")
    if not profile_email or not slot1_txn_at:
        return cors_response(400, {
            "error": "Missing profile email or transaction timestamp — cannot authenticate with iPoolside"
        })

    try:
        txn_clean = slot1_txn_at.replace("Z", "+00:00")
        txn_dt = datetime.fromisoformat(txn_clean)
        txn_str = txn_dt.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        txn_str = slot1_txn_at

    token = base64.b64encode(f"{profile_email}|{txn_str}".encode()).decode().rstrip("=")

    # Authenticate with iPoolside and cancel the booking.
    # Must mirror the browser session setup exactly (login → home page → sites-session
    # → login-session → booking-values → user-cart → cancel) with the correct headers.
    try:
        s = requests.Session()

        # Step 1: Login via email link (sets sessionid + csrftoken cookies)
        login_url = f"{BASE_URL}/api/auth/login-user-from-email/{token}"
        login_resp = s.get(login_url, timeout=15, allow_redirects=False)
        print(f"iPoolside login response: {login_resp.status_code}")

        # Step 2: Load home page (follows redirect target, establishes full session)
        s.get(BASE_URL, timeout=15)

        # Step 3: sites-session (refreshes csrftoken cookie)
        s.get(f"{BASE_URL}/api/auth/sites-session", timeout=10)

        # Step 4: login-session (gets csrf_token + user info)
        login_session_resp = s.get(f"{BASE_URL}/api/auth/login-session", timeout=10)
        try:
            login_data = login_session_resp.json()
            csrf_token = login_data.get("csrf_token")
        except Exception:
            login_data = {}
            csrf_token = None
        csrf_token = csrf_token or s.cookies.get("csrftoken")
        print(f"iPoolside CSRF token: {csrf_token[:20] if csrf_token else 'None'}...")
        print(f"iPoolside session cookies: {list(s.cookies.keys())}")

        # Set headers to match the browser's REST client exactly
        s.headers.update({
            "Accept": "*/*",
            "Content-Type": "text/plain;charset=UTF-8",
            "Origin": BASE_URL,
            "Referer": f"{BASE_URL}/",
            "X-CSRFToken": csrf_token or "",
            "X-Requested-With": "XMLHttpRequest",
        })

        # Step 5: get-booking-values (mirrors browser flow)
        s.get(f"{BASE_URL}/api/palapa/booking/get-booking-values/1", timeout=10)

        # Step 6: user-cart (mirrors browser flow)
        s.post(f"{BASE_URL}/api/cart/user-cart", data="{}", timeout=10)

        # Step 7: Cancel the booking
        cancel_url = f"{BASE_URL}/api/palapa/booking/cancel-booking/{ipoolside_booking_id}"
        print(f"iPoolside cancel URL: {cancel_url}")
        cancel_resp = s.post(cancel_url, data="{}", timeout=15)
        print(f"iPoolside cancel response: {cancel_resp.status_code} {cancel_resp.text[:500]}")

        try:
            cancel_data = cancel_resp.json()
        except Exception:
            cancel_data = {"raw": cancel_resp.text[:300]}

        if cancel_resp.status_code == 200:
            # Update status in DynamoDB
            booking_results_table.update_item(
                Key={"id": result_id},
                UpdateExpression="SET #s = :s, #ca = :ca",
                ExpressionAttributeNames={"#s": "status", "#ca": "cancelled_at"},
                ExpressionAttributeValues={
                    ":s": "cancelled",
                    ":ca": datetime.utcnow().isoformat(),
                },
            )
            return cors_response(200, {
                "message": "Booking cancelled successfully",
                "ipoolside_response": cancel_data,
            })
        else:
            return cors_response(502, {
                "error": "iPoolside cancel request failed",
                "status": cancel_resp.status_code,
                "detail": cancel_data,
            })
    except Exception as e:
        print(f"Error cancelling booking on iPoolside: {e}")
        return cors_response(500, {"error": f"Cancel failed: {str(e)}"})


def parse_booking_input(data, creator_email, existing=None):
    """Validate booking form data and return normalized fields.
    Raises ValueError for bad input."""
    existing = existing or {}
    profile = get_profile_item(creator_email) or {}

    def pick(*sources, default=""):
        for src in sources:
            val = src
            if isinstance(val, str):
                val = val.strip()
            if val:
                return val
        return default

    first = pick(data.get("first"), existing.get("first"), profile.get("first"))
    last = pick(data.get("last"), existing.get("last"), profile.get("last"))
    name = pick(data.get("name"), existing.get("name"), profile.get("name"), f"{first} {last}".strip())
    room = pick(data.get("room"), existing.get("room"), profile.get("room"))
    email = pick(data.get("email"), existing.get("email"), profile.get("email"), creator_email)
    phone = pick(data.get("phone"), existing.get("phone"), profile.get("phone"))

    book_date = (data.get("book_date") or existing.get("book_date") or default_book_date()).strip()
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", book_date):
        raise ValueError("book_date must be YYYY-MM-DD")

    raw_choices = data.get("hut_choices")
    if not raw_choices:
        legacy = data.get("hut_number") or existing.get("hut_number")
        raw_choices = existing.get("hut_choices") or ([legacy] if legacy else [])
    hut_choices = normalize_hut_choices(raw_choices)
    if not hut_choices:
        raise ValueError("At least one hut must be chosen")

    if not room:
        raise ValueError("Missing room")
    if not email:
        raise ValueError("Missing email")

    return {
        "first": first,
        "last": last,
        "name": name,
        "room": room,
        "email": email,
        "phone": phone,
        "book_date": book_date,
        "hut_choices": hut_choices,
    }


def normalize_hut_choices(raw):
    """Dedupe preserving priority; coerce to strings; drop empties."""
    seen = set()
    result = []
    if isinstance(raw, str):
        raw = [c.strip() for c in raw.split(",")]
    for item in raw or []:
        if item is None:
            continue
        key = str(item).strip()
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(key)
    return result


def validate_same_booking_window(palapas, hut_choices):
    """Return an error dict if hut_choices span different booking windows, else None."""
    by_name = {str(p.get("name")): p for p in palapas}
    times = {}
    for hut in hut_choices:
        p = by_name.get(str(hut))
        if not p:
            continue
        bt = p.get("booking_time", DEFAULT_ADVANCE_BOOKING_TIME)
        times[hut] = bt
    unique_times = set(times.values())
    if len(unique_times) > 1:
        return {
            "error": "All selected huts must share the same booking window time. "
                     "Mixing hut types with different opening times would cause backups to fail.",
            "hut_times": times,
        }
    return None


def select_first_available_choice(palapas, locks, hut_choices):
    """Return (matched_palapa_dict, list_of_unavailable) for the first hut
    in `hut_choices` that is available and not internally locked.
    Returns (None, [...]) if none are available."""
    by_name = {str(p.get("name")): p for p in palapas}
    unavailable = []
    for hut in hut_choices:
        palapa = by_name.get(str(hut))
        if not palapa:
            unavailable.append({"hut": hut, "reason": "not found"})
            continue
        if str(hut) in locks:
            unavailable.append({"hut": hut, "reason": locks[str(hut)].get("reason", "held")})
            continue
        if not palapa.get("available"):
            unavailable.append({"hut": hut, "reason": palapa.get("status_label", "unavailable")})
            continue
        return palapa, unavailable
    return None, unavailable


def find_palapa_metadata(palapas, hut_choices):
    """Return the palapa dict for the first hut choice (for metadata like
    booking_time), regardless of availability. Returns None only if the
    hut doesn't exist at all."""
    by_name = {str(p.get("name")): p for p in palapas}
    for hut in hut_choices:
        palapa = by_name.get(str(hut))
        if palapa:
            return palapa
    return None


def merge_profile_overrides(profile, data):
    """Let the request body override profile fields where supplied."""
    merged = dict(profile)
    for key in ("first", "last", "name", "room", "email", "phone"):
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            merged[key] = val.strip()
    return merged


def build_schedule_name(last, hut, booking_time, booking_id):
    last_part = re.sub(r"[^A-Za-z0-9]", "", (last or "user")) or "user"
    hut_part = re.sub(r"[^A-Za-z0-9]", "", str(hut))
    time_part = (booking_time or "0000").replace(":", "")
    return f"{last_part}-{hut_part}-{time_part}-{booking_id[:8]}"


# ---------------------------------------------------------------------------
# Scheduling helpers
# ---------------------------------------------------------------------------

def schedule_one_time_job(schedule_name, payload, book_date, booking_time, palapatype, debug_mode=False):
    """Create a one-time EventBridge schedule using `at(...)` and Aruba tz."""
    window_time = compute_schedule_fire_time(book_date, booking_time, palapatype)
    fire_local = window_time - timedelta(seconds=LEAD_TIME_SECONDS)
    now_local = datetime.now(ARUBA_TZ)
    if fire_local <= now_local:
        # If we're already past the window, schedule 1 minute out so it fires right away.
        fire_local = now_local + timedelta(minutes=1)
    target_arn = DEBUG_TARGET_LAMBDA_ARN if debug_mode else TARGET_LAMBDA_ARN
    schedule_expression = "at(" + fire_local.strftime("%Y-%m-%dT%H:%M:%S") + ")"
    payload = {**payload, "debug_mode": debug_mode}
    scheduler.create_schedule(
        Name=schedule_name,
        GroupName=SCHEDULE_GROUP,
        ScheduleExpression=schedule_expression,
        ScheduleExpressionTimezone="America/Aruba",
        Target={
            "Arn": target_arn,
            "RoleArn": INVOKE_ROLE_ARN,
            "Input": json.dumps(payload),
        },
        FlexibleTimeWindow={"Mode": "OFF"},
        ActionAfterCompletion="DELETE",
    )


def compute_schedule_fire_time(book_date, booking_time, palapatype):
    """Return a tz-aware America/Aruba datetime for when the schedule should fire.
    Uses the palapa type to decide if the schedule is same-day or day-before."""
    hour, minute = parse_booking_time(booking_time or DEFAULT_ADVANCE_BOOKING_TIME)
    target_date = datetime.strptime(book_date, "%Y-%m-%d").date()
    if not is_same_day_palapa(palapatype):
        target_date = target_date - timedelta(days=1)
    naive = datetime(target_date.year, target_date.month, target_date.day, hour, minute)
    return ARUBA_TZ.localize(naive)


def parse_booking_time(value):
    parts = str(value).split(":")
    hour = int(parts[0])
    minute = int(parts[1]) if len(parts) > 1 else 0
    return hour, minute


def is_same_day_palapa(palapatype):
    return "same day" in (palapatype or "").lower()


def check_book_now_allowed(book_date, palapatype, booking_time):
    """Return (allowed, window_start_aruba_dt)."""
    default_time = DEFAULT_SAME_DAY_BOOKING_TIME if is_same_day_palapa(palapatype) else DEFAULT_ADVANCE_BOOKING_TIME
    window_start = compute_schedule_fire_time(book_date, booking_time or default_time, palapatype)
    now_aruba = datetime.now(ARUBA_TZ)
    return now_aruba >= window_start, window_start


# ---------------------------------------------------------------------------
# Misc helpers
# ---------------------------------------------------------------------------

def claim_email(event):
    claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
    return claims.get("email")


def get_user_role(email):
    try:
        res = users_table.get_item(Key={"email": email})
        item = res.get("Item")
        return item.get("role") if item else None
    except Exception as e:
        print("Error fetching user role:", str(e))
        return None


def parse_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on", "debug"}
    return bool(value)


def get_requested_log_group(event):
    params = event.get("queryStringParameters") or {}
    requested = params.get("logGroup") or params.get("log_group") or ""
    if requested == DEBUG_LOG_GROUP or requested.lower() == "debug":
        return DEBUG_LOG_GROUP
    if requested == STANDARD_LOG_GROUP or requested.lower() == "standard":
        return STANDARD_LOG_GROUP
    return STANDARD_LOG_GROUP


def get_query_param(event, name, default=None):
    params = event.get("queryStringParameters") or {}
    return params.get(name, default)


def default_book_date():
    """Default to tomorrow in Aruba time."""
    now_aruba = datetime.now(ARUBA_TZ)
    return (now_aruba + timedelta(days=1)).strftime("%Y-%m-%d")


def get_all_bookings_from_schedules(role, email):
    schedules = []
    try:
        response = scheduler.list_schedules(GroupName=SCHEDULE_GROUP)
        for s in response.get("Schedules", []):
            schedule_name = s["Name"]
            try:
                details = scheduler.get_schedule(Name=schedule_name, GroupName=SCHEDULE_GROUP)
                input_payload = json.loads(details["Target"]["Input"])
                if role == "admin" or input_payload.get("creator_email") == email:
                    choices = hut_choices_from_payload(input_payload)
                    schedules.append({
                        "id": schedule_name,
                        "first": input_payload.get("first", ""),
                        "last": input_payload.get("last", ""),
                        "name": input_payload.get("name", ""),
                        "hut_number": input_payload.get("hut_number", choices[0] if choices else ""),
                        "hut_choices": choices,
                        "room": input_payload.get("room", ""),
                        "email": input_payload.get("email", ""),
                        "phone": input_payload.get("phone", ""),
                        "book_date": input_payload.get("book_date", ""),
                        "booking_time": input_payload.get("booking_time", ""),
                        "palapatype_name": input_payload.get("palapatype_name", ""),
                        "debug_mode": parse_bool(input_payload.get("debug_mode")),
                        "status": details.get("State", "UNKNOWN"),
                        "schedule_expression": details.get("ScheduleExpression"),
                        "schedule_timezone": details.get("ScheduleExpressionTimezone"),
                        "scheduleName": schedule_name,
                        "creator_email": input_payload.get("creator_email", ""),
                        "profile_id": input_payload.get("profile_id", input_payload.get("profile_email", "")),
                        "profile_email": input_payload.get("profile_email", ""),
                    })
            except Exception as e:
                print(f"Error retrieving schedule {schedule_name}: {e}")
    except Exception as e:
        print("Error listing schedules:", str(e))
    return cors_response(200, schedules)


def extract_schedule_name(messages):
    try:
        for msg in messages:
            if "'id':" in msg or '"id":' in msg:
                normalized = msg.replace("'", '"')
                data = json.loads(normalized)
                nested_event = data.get("event") if isinstance(data.get("event"), dict) else {}
                return (
                    data.get("id")
                    or data.get("scheduleName")
                    or nested_event.get("id")
                    or nested_event.get("scheduleName")
                )
    except Exception as e:
        print("extract_schedule_name failed:", e)
    return None


def marriott_session():
    s = requests.Session()
    s.get(BASE_URL, timeout=10)
    s.get(SEATING_URL, timeout=10)
    s.get(f"{BASE_URL}/api/translations/translations?language=en&return_as=dict", timeout=10)
    s.get(f"{BASE_URL}/api/auth/sites-session", timeout=10)
    login_response = s.get(f"{BASE_URL}/api/auth/login-session", timeout=10)
    try:
        csrf_token = login_response.json().get("csrf_token")
    except Exception:
        csrf_token = None
    csrf_token = csrf_token or s.cookies.get("csrftoken")
    s.headers.update({
        "Accept": "*/*",
        "Content-Type": "text/plain;charset=UTF-8",
        "Language": "en",
        "Locale": "en-US",
        "Origin": BASE_URL,
        "Referer": SEATING_URL,
        "X-CSRFToken": csrf_token or "",
        "X-Requested-With": "XMLHttpRequest",
    })
    return s


def status_label(status):
    labels = {
        1: "Available",
        2: "Booked",
        5: "Staff Hold",
        7: "Reserved",
        50: "In cart",
    }
    return labels.get(status, f"Status {status}" if status is not None else "Unknown")


def sort_palapa_key(item):
    order_idx = item.get("order_idx")
    if isinstance(order_idx, int):
        return (order_idx, item.get("name", ""))
    try:
        return (int(order_idx), item.get("name", ""))
    except (TypeError, ValueError):
        pass
    try:
        return (int(item.get("name", 999999)), item.get("name", ""))
    except (TypeError, ValueError):
        return (999999, item.get("name", ""))


def fetch_palapa_options(book_date):
    s = marriott_session()
    try:
        palapas = s.post(
            f"{BASE_URL}/api/palapa/get-palapas",
            json={"seating_name": None},
            timeout=15,
        ).json().get("palapas", [])
        bookings = s.post(
            f"{BASE_URL}/api/palapa/booking/get-auto-update-bookings/1",
            json={"book_date": book_date},
            timeout=15,
        ).json().get("bookings", [])

        bookings_by_palapa = {b.get("palapa_id"): b for b in bookings}
        options = []
        for palapa in palapas:
            if not palapa.get("name"):
                continue
            booking = bookings_by_palapa.get(palapa.get("id")) or {}
            status = booking.get("status")
            slot1_status = booking.get("slot1_status")
            option = {
                "id": palapa.get("id"),
                "name": palapa.get("name"),
                "long_name": palapa.get("long_name") or palapa.get("palapa_long_name", ""),
                "palapatype_name": palapa.get("palapatype_name", ""),
                "zone_name": palapa.get("zone_name", ""),
                "zone_color": palapa.get("zone_color", ""),
                "loc_lon": palapa.get("loc_lon"),
                "loc_lat": palapa.get("loc_lat"),
                "booking_id": booking.get("id"),
                "booking_time": booking.get("advanced_booking_time", "07:00"),
                "until_booking_time": booking.get("until_booking_time"),
                "book_date": booking.get("book_date", book_date),
                "order_idx": booking.get("order_idx"),
                "status": status,
                "slot1_status": slot1_status,
                "status_label": status_label(status),
                "available": status == 1 and slot1_status == 1,
                "price": booking.get("price"),
                "fullday_booked": booking.get("fullday_booked"),
            }
            options.append(option)
        return sorted(options, key=sort_palapa_key)
    except Exception as e:
        print("Marriott API error:", str(e))
        raise


def cors_response(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
            "Content-Type": "application/json",
        },
        "body": json.dumps(body),
    }
