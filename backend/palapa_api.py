import json
import requests
import boto3
import uuid
from datetime import datetime, timedelta
from botocore.exceptions import ClientError
import pytz
import urllib.parse

dynamodb = boto3.resource("dynamodb")
users_table = dynamodb.Table("palapa-users")
scheduler = boto3.client("scheduler")

TARGET_LAMBDA_ARN = "arn:aws:lambda:us-east-1:561031966991:function:execute-palapa-booking"
DEBUG_TARGET_LAMBDA_ARN = "arn:aws:lambda:us-east-1:561031966991:function:execute-palapa-booking-debug"
INVOKE_ROLE_ARN = "arn:aws:iam::561031966991:role/InvokePalapaLambdaRole"
STANDARD_LOG_GROUP = "/aws/lambda/execute-palapa-booking"
DEBUG_LOG_GROUP = "/aws/lambda/execute-palapa-booking-debug"
LOG_GROUPS = [
    {"log_group": STANDARD_LOG_GROUP, "function_mode": "standard"},
    {"log_group": DEBUG_LOG_GROUP, "function_mode": "debug"},
]

def lambda_handler(event, context):
    print("Event received:", json.dumps(event))
    
    path = event.get("rawPath", "")
    method = event.get("requestContext", {}).get("http", {}).get("method")

    # Handle CORS preflight
    if method == "OPTIONS":
        return cors_response(200, {})

    # Handle /auth-check
    if path == "/auth-check":
        claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
        email = claims.get("email")
        if not email:
            return cors_response(403, {"error": "Missing email in token"})
        role = get_user_role(email)
        if not role:
            return cors_response(403, {"error": "Unauthorized user"})
        return cors_response(200, {"email": email, "role": role})

    # Auth required for all other routes
    claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
    email = claims.get("email")
    if not email:
        return cors_response(403, {"error": "Missing email in token"})
    role = get_user_role(email)
    if not role:
        return cors_response(403, {"error": "Unauthorized user"})

    # POST /users
    if method == "POST" and path == "/users":
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

    # GET /users
    if method == "GET" and path == "/users":
        if role != "admin":
            return cors_response(403, {"error": "Only admins can view users"})
        try:
            response = users_table.scan()
            users = response.get("Items", [])
            return cors_response(200, users)
        except Exception as e:
            print("Error listing users:", str(e))
            return cors_response(500, {"error": str(e)})

    # DELETE /users/{email}
    if method == "DELETE" and path.startswith("/users/"):
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

    # GET /logs
    if method == "GET" and path == "/logs":
        if role != "admin":
            return cors_response(403, {"error": "Only admins can view logs"})
    
        try:
            logs_client = boto3.client('logs')
    
            now = datetime.utcnow()
            two_days_ago = int((now - timedelta(days=2)).timestamp() * 1000)

            schedule_latest = {}

            for group in LOG_GROUPS:
                log_group = group["log_group"]
                function_mode = group["function_mode"]
                try:
                    streams_response = logs_client.describe_log_streams(
                        logGroupName=log_group,
                        orderBy='LastEventTime',
                        descending=True,
                        limit=50
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
                        startFromHead=True
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
                            "messages": limited_messages
                        }
    
            return cors_response(200, {
                "stream_count": len(schedule_latest),
                "streams": list(schedule_latest.values())
            })
    
        except Exception as e:
            print("Failed to get logs:", str(e))
            return cors_response(500, {"error": str(e)})
    
    # GET /logs/{streamName}
    if method == "GET" and path.startswith("/logs/"):
        if role != "admin":
            return cors_response(403, {"error": "Only admins can view logs"})
    
        stream_name = ""
        try:
            stream_name_encoded = path[len("/logs/"):]
            stream_name = urllib.parse.unquote(stream_name_encoded)
            log_group = get_requested_log_group(event)
            logs_client = boto3.client('logs')
    
            events = logs_client.get_log_events(
                logGroupName=log_group,
                logStreamName=stream_name,
                limit=10000,
                startFromHead=True
            ).get("events", [])
    
            messages = [e["message"].strip() for e in events if e.get("message")]
    
            return cors_response(200, {
                "streamName": stream_name,
                "logGroup": log_group,
                "messageCount": len(messages),
                "messages": messages
            })
    
        except Exception as e:
            print(f"Error fetching full logs for {stream_name}:", str(e))
            return cors_response(500, {"error": str(e)})

    # GET /bookings
    if method == "GET" and path == "/bookings":
        return get_all_bookings_from_schedules(role, email)

    # POST /bookings
    if method == "POST" and path == "/bookings":
        try:
            data = json.loads(event["body"])
            first = data.get("first", "").strip()
            last = data.get("last", "").strip()
            name = data.get("name") or f"{first} {last}".strip()
            hut_number = data.get("hut_number")
            room = data.get("room")
            email_field = data.get("email")
            phone = data.get("phone", "")
            debug_mode = parse_bool(data.get("debug_mode"))
    
            if not hut_number or not room or not email_field:
                return cors_response(400, {"error": "Missing hut_number, room, or email"})
    
            # Check for duplicates
            conflicts = set()
            response = scheduler.list_schedules(GroupName="default")
            for s in response.get("Schedules", []):
                try:
                    details = scheduler.get_schedule(Name=s["Name"], GroupName="default")
                    input_payload = json.loads(details["Target"]["Input"])
                    if input_payload.get("hut_number") == hut_number:
                        conflicts.add("hut_number")
                    if input_payload.get("room") == room:
                        conflicts.add("room")
                    if input_payload.get("email") == email_field:
                        conflicts.add("email")
                except Exception as e:
                    print(f"Error checking schedule for conflict: {e}")
    
            if conflicts:
                return cors_response(409, {
                    "error": "Conflict with existing booking",
                    "conflicting_fields": list(conflicts)
                })
    
            # Fetch palapa info
            palapa = fetch_palapa_details(hut_number)
            if not palapa:
                return cors_response(404, {"error": f"Hut {hut_number} not found"})
    
            booking_time = palapa.get("advanced_booking_time", "07:00")
            booking_id = str(uuid.uuid4())

            schedule_name = f"{(last or 'unknown').replace(' ', '')}-{hut_number}-{booking_time.replace(':', '')}-{booking_id[:8]}"
    
            full_item = {
                "id": booking_id,
                "first": first,
                "last": last,
                "name": name,
                "email": email_field,
                "phone": phone,
                "hut_number": hut_number,
                "room": room,
                "booking_time": booking_time,
                "created_at": datetime.utcnow().isoformat(),
                "creator_email": email,
                "debug_mode": debug_mode
            }
    
            schedule_cron_job(schedule_name, full_item, booking_time, debug_mode=debug_mode)
    
            return cors_response(200, {
                "message": "Booking scheduled",
                "booking_time": booking_time,
                "id": booking_id,
                "schedule_name": schedule_name,
                "debug_mode": debug_mode
            })
    
        except Exception as e:
            print("Error:", str(e))
            return cors_response(500, {"error": str(e)})

            
    if method == "PUT" and path.startswith("/bookings/"):
        schedule_name = path.split("/")[-1]
        try:
            updated_data = json.loads(event["body"])
            first = updated_data.get("first", "").strip()
            last = updated_data.get("last", "").strip()
            name = updated_data.get("name") or f"{first} {last}".strip()
            hut_number = updated_data.get("hut_number")
            room = updated_data.get("room")
            email_field = updated_data.get("email")
            phone = updated_data.get("phone", "")
    
            if not hut_number or not room or not email_field:
                return cors_response(400, {"error": "Missing hut_number, room, or email"})
    
            # Check for duplicates
            conflicts = set()
            response = scheduler.list_schedules(GroupName="default")
            for s in response.get("Schedules", []):
                if s["Name"] == schedule_name:
                    continue
                try:
                    details = scheduler.get_schedule(Name=s["Name"], GroupName="default")
                    input_payload = json.loads(details["Target"]["Input"])
                    if input_payload.get("hut_number") == hut_number:
                        conflicts.add("hut_number")
                    if input_payload.get("room") == room:
                        conflicts.add("room")
                    if input_payload.get("email") == email_field:
                        conflicts.add("email")
                except Exception as e:
                    print(f"Error checking schedule for conflict: {e}")
    
            if conflicts:
                readable = {
                    "hut_number": "That hut is already booked.",
                    "room": "That room is already associated with a booking.",
                    "email": "That email already has a scheduled booking."
                }
                conflict_messages = [readable[field] for field in conflicts if field in readable]
                return cors_response(409, {
                    "error": "Booking could not be updated due to conflicts.",
                    "conflicting_fields": list(conflicts),
                    "messages": conflict_messages
                })
    
            # Fetch current payload to preserve id and created_at
            try:
                current_schedule = scheduler.get_schedule(Name=schedule_name, GroupName="default")
                current_payload = json.loads(current_schedule["Target"]["Input"])
            except Exception as e:
                print(f"Error fetching existing schedule payload: {e}")
                current_payload = {}
            debug_mode = parse_bool(updated_data.get("debug_mode", current_payload.get("debug_mode", False)))

            # Cancel existing schedule
            scheduler.delete_schedule(Name=schedule_name, GroupName="default")
    
            # Fetch palapa info
            palapa = fetch_palapa_details(hut_number)
            if not palapa:
                return cors_response(404, {"error": f"Hut {hut_number} not found"})
            booking_time = palapa.get("advanced_booking_time", "07:00")
    
            # Preserve id and created_at
            full_item = {
                "id": current_payload.get("id", str(uuid.uuid4())),
                "created_at": current_payload.get("created_at", datetime.utcnow().isoformat()),
                "first": first,
                "last": last,
                "name": name,
                "email": email_field,
                "phone": phone,
                "hut_number": hut_number,
                "room": room,
                "booking_time": booking_time,
                "creator_email": email,
                "debug_mode": debug_mode
            }
    
            schedule_cron_job(schedule_name, full_item, booking_time, debug_mode=debug_mode)
    
            return cors_response(200, {"message": f"Booking {schedule_name} updated", "debug_mode": debug_mode})
        except Exception as e:
            print(f"Error updating booking {schedule_name}:", str(e))
            return cors_response(500, {"error": str(e)})



    # DELETE /bookings/{scheduleName}
    if method == "DELETE" and path.startswith("/bookings/"):
        schedule_name = path.split("/")[-1]
        try:
            scheduler.delete_schedule(Name=schedule_name, GroupName="default")
            print(f"Schedule {schedule_name} deleted.")
            return cors_response(200, {"message": f"Schedule '{schedule_name}' deleted."})
        except ClientError as e:
            print(f"Error deleting schedule {schedule_name}: {e}")
            return cors_response(500, {"error": str(e)})

    return cors_response(405, {"error": "Method not allowed"})


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


def get_all_bookings_from_schedules(role, email):
    schedules = []
    try:
        response = scheduler.list_schedules(GroupName="default")
        for s in response.get("Schedules", []):
            schedule_name = s["Name"]
            try:
                details = scheduler.get_schedule(Name=schedule_name, GroupName="default")
                input_payload = json.loads(details["Target"]["Input"])

                # Only return bookings for this user unless admin
                if role == "admin" or input_payload.get("creator_email") == email:
                    schedules.append({
                        "id": schedule_name,
                        "first": input_payload.get("first", ""),
                        "last": input_payload.get("last", ""),
                        "name": input_payload.get("name", ""),  # fallback for legacy data
                        "hut_number": input_payload.get("hut_number", ""),
                        "room": input_payload.get("room", ""),
                        "email": input_payload.get("email", ""),
                        "phone": input_payload.get("phone", ""),
                        "booking_time": input_payload.get("booking_time", ""),
                        "debug_mode": parse_bool(input_payload.get("debug_mode")),
                        "status": details.get("State", "UNKNOWN"),
                        "schedule_expression": details.get("ScheduleExpression"),
                        "scheduleName": schedule_name
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


def fetch_palapa_details(hut_number):
    today = datetime.today()
    tomorrow_str = (today + timedelta(days=1)).strftime('%Y-%m-%d')
    s = requests.Session()
    try:
        s.get('https://marriottarubasurfclub.ipoolside.com')
        s.get('https://marriottarubasurfclub.ipoolside.com/api/translations/translations?language=en&return_as=dict')
        s.get('https://marriottarubasurfclub.ipoolside.com/api/auth/sites-session')
        s.get('https://marriottarubasurfclub.ipoolside.com/api/auth/login-session')

        csrf_token = s.cookies.get('csrftoken')
        s.headers.update({
            "Content-Type": "text/plain;charset=UTF-8",
            "Referer": "https://marriottarubasurfclub.ipoolside.com/",
            "X-CSRFToken": csrf_token
        })

        palapas = s.post("https://marriottarubasurfclub.ipoolside.com/api/palapa/get-palapas",
                         json={"seating_name": None}).json().get('palapas', [])

        palapa = next((p for p in palapas if p.get("name") == hut_number), None)
        if not palapa:
            return None

        bookings = s.post("https://marriottarubasurfclub.ipoolside.com/api/palapa/booking/get-bookings/1",
                          json={"book_date": tomorrow_str}).json().get('bookings', [])

        booking = next((b for b in bookings if b.get("palapa_id") == palapa["id"]), None)
        palapa["advanced_booking_time"] = booking.get("advanced_booking_time", "07:00") if booking else "07:00"

        return palapa
    except Exception as e:
        print("Marriott API error:", str(e))
        return None


def schedule_cron_job(schedule_name, payload, booking_time, debug_mode=False):
    try:
        local = pytz.timezone("America/New_York")
        naive_time = datetime.strptime(booking_time, "%H:%M")
        now = datetime.now()
        est_datetime = local.localize(datetime(
            year=now.year, month=now.month, day=now.day,
            hour=naive_time.hour, minute=naive_time.minute
        ))
        utc_datetime = est_datetime.astimezone(pytz.utc) - timedelta(minutes=1)
        cron_expr = f"cron({utc_datetime.minute} {utc_datetime.hour} * * ? *)"
        target_arn = DEBUG_TARGET_LAMBDA_ARN if debug_mode else TARGET_LAMBDA_ARN
        payload = {
            **payload,
            "debug_mode": debug_mode,
        }

        scheduler.create_schedule(
            Name=schedule_name,
            GroupName="default",
            ScheduleExpression=cron_expr,
            Target={
                "Arn": target_arn,
                "RoleArn": INVOKE_ROLE_ARN,
                "Input": json.dumps(payload)
            },
            FlexibleTimeWindow={"Mode": "OFF"}
        )
    except Exception as e:
        print("Error scheduling cron job:", str(e))
        raise


def cors_response(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
            "Content-Type": "application/json"
        },
        "body": json.dumps(body)
    }
