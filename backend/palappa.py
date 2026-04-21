import asyncio
import base64
import json
import os
import time
import traceback
from contextvars import ContextVar
from datetime import datetime, timedelta

import aiohttp
import pytz


# Tuning parameters
# PREFIRE_MS: start firing reserve requests this many ms BEFORE the window opens.
# Pre-window responses (slot1_status=1, no owner) are rejected and the loop
# keeps firing, so one request lands within ~30-80ms of the actual open.
PREFIRE_MS = 500
WINDOW_MS = 1000
MAX_SHOTS = 200
MAX_IN_FLIGHT = 25

BASE_URL = "https://marriottarubasurfclub.ipoolside.com"
SEATING_URL = f"{BASE_URL}/seating/next-day-reservation"
LOCAL_TZ = pytz.timezone("America/Aruba")
DEBUG_PREVIEW_CHARS = 800
DEBUG_LOGGING = ContextVar(
    "DEBUG_LOGGING",
    default=os.getenv("PALAPA_DEBUG_LOGGING", "").lower() in {"1", "true", "yes", "on"},
)

PROFILES_TABLE_NAME = os.environ.get("PALAPA_PROFILES_TABLE", "palapa-profiles")
BOOKING_RESULTS_TABLE_NAME = os.environ.get("PALAPA_BOOKING_RESULTS_TABLE", "palapa-booking-results")

TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN", "")
TWILIO_FROM_NUMBER = os.environ.get("TWILIO_FROM_NUMBER", "")


def _profiles_table():
    """Return a boto3 DDB Table for profile lookups. Imported lazily so unit tests
    that don't need AWS don't blow up."""
    import boto3
    return boto3.resource("dynamodb").Table(PROFILES_TABLE_NAME)


def _booking_results_table():
    """Return a boto3 DDB Table for booking results. Lazy import."""
    import boto3
    return boto3.resource("dynamodb").Table(BOOKING_RESULTS_TABLE_NAME)


def save_booking_result(event, profile, booking_date, selected_hut,
                        ipoolside_booking_id, order_number, verified,
                        manage_url, slot1_transaction_at):
    """Persist a completed booking result to DynamoDB."""
    booking_id = event.get("id") or str(int(time.time()))
    item = {
        "id": booking_id,
        "ipoolside_booking_id": ipoolside_booking_id or "",
        "book_date": booking_date,
        "hut": str(selected_hut),
        "hut_choices": event.get("hut_choices") or [str(selected_hut)],
        "order_number": order_number or "",
        "verified": verified,
        "status": "confirmed",
        "manage_url": manage_url or "",
        "slot1_transaction_at": slot1_transaction_at or "",
        "profile_email": profile.get("email", ""),
        "profile_name": profile.get("name", ""),
        "creator_email": event.get("creator_email", profile.get("email", "")),
        "schedule_name": event.get("schedule_name", ""),
        "created_at": datetime.utcnow().isoformat(),
    }
    try:
        _booking_results_table().put_item(Item=item)
        print(f"Booking result saved: {booking_id}")
        log_debug("booking_result_saved", id=booking_id, hut=selected_hut)
    except Exception as e:
        print(f"Failed to save booking result: {e}")
        log_debug("booking_result_save_failed", error=str(e))


async def send_sms_notification(message, to_phone):
    """Send an SMS via Twilio REST API. Skips silently if Twilio is not configured."""
    if not all([TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, to_phone]):
        print("SMS skipped — Twilio not configured or no notification phone")
        return

    url = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json"
    auth = aiohttp.BasicAuth(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    form = aiohttp.FormData()
    form.add_field("From", TWILIO_FROM_NUMBER)
    form.add_field("To", to_phone)
    form.add_field("Body", message)

    try:
        async with aiohttp.ClientSession() as sms_session:
            async with sms_session.post(url, data=form, auth=auth) as resp:
                text = await resp.text()
                print(f"SMS sent: {resp.status} {text[:200]}")
                log_debug("sms_sent", status=resp.status, to=redact_value(to_phone))
    except Exception as e:
        print(f"SMS notification failed: {e}")
        log_debug("sms_failed", error=str(e))


def resolve_profile(event):
    """Return the latest profile to use for this booking.

    Precedence: DDB profile (by profile_email/creator_email) > explicit event fields.
    Fields: first, last, name, room, email, phone.
    """
    profile_email = event.get("profile_email") or event.get("creator_email") or event.get("email")
    stored = {}
    if profile_email:
        try:
            res = _profiles_table().get_item(Key={"email": profile_email})
            stored = res.get("Item") or {}
        except Exception as e:
            print(f"Profile lookup failed for {profile_email}: {e}")
            log_debug("profile_lookup_failed", profile_email=profile_email, error=str(e))

    def prefer(key, default=""):
        val = stored.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
        event_val = event.get(key)
        if isinstance(event_val, str) and event_val.strip():
            return event_val.strip()
        return default

    first = prefer("first")
    last = prefer("last")
    name = prefer("name") or f"{first} {last}".strip()
    sms_enabled = stored.get("sms_enabled")
    if sms_enabled is None:
        sms_enabled = event.get("sms_enabled", False)

    return {
        "first": first,
        "last": last,
        "name": name,
        "email": prefer("email") or profile_email or "",
        "phone": prefer("phone"),
        "room": prefer("room"),
        "notification_phone": prefer("notification_phone"),
        "sms_enabled": bool(sms_enabled),
    }


def resolve_hut_choices(event):
    raw = event.get("hut_choices")
    if isinstance(raw, list) and raw:
        return [str(h).strip() for h in raw if str(h).strip()]
    legacy = event.get("hut_number")
    if legacy:
        return [str(legacy).strip()]
    return []


def resolve_book_date(event, palapatype_name=""):
    """Return the book_date string, defaulting from palapa type and Aruba time."""
    explicit = event.get("book_date")
    if explicit:
        return str(explicit)
    today = datetime.now(LOCAL_TZ).date()
    if "same day" in (palapatype_name or "").lower():
        return str(today)
    return str(today + timedelta(days=1))


def select_booking_for_hut(palapas, bookings_by_palapa, hut_number):
    """Return (palapa, booking) for the given hut or (None, None) if missing."""
    palapa = next((p for p in palapas if str(p.get("name")) == str(hut_number)), None)
    if not palapa:
        return None, None
    booking = bookings_by_palapa.get(palapa.get("id"))
    return palapa, booking


def booking_is_viable(booking):
    """A booking is viable if it exists and its slot is available (status/slot1_status 1)."""
    if not booking:
        return False
    if booking.get("status") != 1:
        return False
    if booking.get("slot1_status") not in (None, 1):
        return False
    return True


def redact_value(value):
    if value is None:
        return None
    value = str(value)
    if not value:
        return value
    if "@" in value:
        name, _, domain = value.partition("@")
        return f"{name[:2]}***@{domain}"
    if len(value) <= 4:
        return "***"
    return f"{value[:2]}***{value[-2:]}"


def redact_mapping(data):
    if not isinstance(data, dict):
        return data

    redacted = {}
    sensitive_keys = {
        "email",
        "email_address",
        "phone",
        "phone_no",
        "csrf",
        "csrf_token",
        "csrftoken",
        "sessionid",
        "authorization",
        "x-csrftoken",
    }
    for key, value in data.items():
        key_text = str(key).lower()
        if key_text in sensitive_keys or "token" in key_text:
            redacted[key] = redact_value(value)
        elif isinstance(value, dict):
            redacted[key] = redact_mapping(value)
        else:
            redacted[key] = value
    return redacted


def log_debug(name, **fields):
    if not DEBUG_LOGGING.get():
        return

    record = {
        "debug": True,
        "name": name,
        "utc": datetime.utcnow().isoformat(),
        **redact_mapping(fields),
    }
    print("PALAPA_DEBUG " + json.dumps(record, default=str, sort_keys=True))


def response_preview(text):
    if text is None:
        return None
    return text[:DEBUG_PREVIEW_CHARS]


def summarize_booking(booking):
    if not isinstance(booking, dict):
        return booking

    keys = [
        "id",
        "palapa_id",
        "palapa_name",
        "palapatype_name",
        "book_date",
        "status",
        "slot1_status",
        "slot2_status",
        "fullday_booked",
        "advanced_booking",
        "advanced_booking_time",
        "until_booking",
        "until_booking_time",
        "slot1_booked_at",
        "slot1_transaction_at",
        "slot1_booked_user_id",
        "slot1_booked_user_name",
        "can_checkout",
        "anonymous_id",
    ]
    return redact_mapping({key: booking.get(key) for key in keys if key in booking})


def summarize_palapa(palapa):
    if not isinstance(palapa, dict):
        return palapa

    keys = [
        "id",
        "name",
        "palapatype_name",
        "zone_name",
        "active",
        "is_available",
    ]
    return {key: palapa.get(key) for key in keys if key in palapa}


async def request_text(session, method, url, label, **kwargs):
    started_perf = time.perf_counter()
    sent_at = datetime.utcnow()
    params = kwargs.get("params")
    json_payload = kwargs.get("json")

    try:
        async with session.request(method, url, **kwargs) as resp:
            text = await resp.text()
            received_at = datetime.utcnow()
            rtt_ms = (time.perf_counter() - started_perf) * 1000
            log_debug(
                "http_response",
                label=label,
                method=method.upper(),
                url=url,
                params=params,
                json_payload=redact_mapping(json_payload) if isinstance(json_payload, dict) else json_payload,
                status=resp.status,
                rtt_ms=round(rtt_ms, 2),
                sent_at=sent_at.isoformat(),
                received_at=received_at.isoformat(),
                response_date=resp.headers.get("Date"),
                content_type=resp.headers.get("Content-Type"),
                response_chars=len(text),
                response_preview=response_preview(text),
            )
            return resp.status, text, dict(resp.headers)
    except Exception as e:
        log_debug(
            "http_exception",
            label=label,
            method=method.upper(),
            url=url,
            params=params,
            error=str(e),
            traceback=traceback.format_exc(),
        )
        raise


def is_successful_response(text: str) -> bool:
    if not text:
        return False

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        print(f"Add-to-cart returned non-JSON response: {text[:300]}")
        return False

    if data.get("success") == "ok":
        return True

    message = str(data.get("message", ""))
    print(f"Add-to-cart was not successful: {message[:300]}")
    return False


async def create_payload(event_or_profile):
    """Build the final book-from-cart POST body.

    Accepts either a raw event (legacy) or a resolved profile dict (new).
    """
    profile = event_or_profile or {}
    return {
        "email_address": profile.get("email", ""),
        "full_name": profile.get("name", ""),
        "last_name": profile.get("last", ""),
        "first_name": profile.get("first", ""),
        "reservation_no": "",
        "room": profile.get("room", ""),
        "club_member": "",
        "club_member_email": "",
        "orig_reservation_no": "",
        "phone_no": profile.get("phone", ""),
        "country_code": "1",
        "opt_in_email": False,
        "opt_in_sms": False,
        "agree_promo": False,
        "terms_accepted": True,
        "company_name": "",
        "iata_number": "",
        "preference_note": "",
    }


async def initialize_session():
    timeout = aiohttp.ClientTimeout(total=20, connect=5, sock_read=15)
    connector = aiohttp.TCPConnector(limit=MAX_IN_FLIGHT)
    session = aiohttp.ClientSession(connector=connector, timeout=timeout)

    await request_text(session, "get", BASE_URL, "home")
    await request_text(session, "get", SEATING_URL, "seating-page")
    await request_text(session, "get", f"{BASE_URL}/api/auth/sites-session", "sites-session")
    _, login_text, _ = await request_text(
        session,
        "get",
        f"{BASE_URL}/api/auth/login-session",
        "login-session",
    )
    try:
        login_data = json.loads(login_text)
    except json.JSONDecodeError:
        login_data = {}
        log_debug("login_session_non_json", response_preview=response_preview(login_text))

    csrf_cookie = None
    for cookie in session.cookie_jar:
        if cookie.key == "csrftoken":
            csrf_cookie = cookie.value
            break
    csrf = login_data.get("csrf_token") or csrf_cookie

    session.headers.update(
        {
            "Accept": "*/*",
            "Content-Type": "text/plain;charset=UTF-8",
            "Language": "en",
            "Locale": "en-US",
            "Origin": BASE_URL,
            "Referer": SEATING_URL,
            "X-CSRFToken": csrf or "",
            "X-Requested-With": "XMLHttpRequest",
        }
    )
    anonymous_id = login_data.get("anonymous_id")
    log_debug(
        "session_initialized",
        csrf_source="login-session" if login_data.get("csrf_token") else "cookie",
        csrf_present=bool(csrf),
        csrf_length=len(csrf or ""),
        anonymous_id=anonymous_id,
        cookie_names=sorted({cookie.key for cookie in session.cookie_jar}),
        max_in_flight=MAX_IN_FLIGHT,
    )
    return session, csrf, anonymous_id


def get_booking_date(palapa_type):
    today = datetime.now(LOCAL_TZ)
    if "same day" in palapa_type.lower():
        return str(today.date())
    return str((today + timedelta(days=1)).date())


def wait_until_prefire(booking_start):
    now_utc = datetime.now(pytz.utc)
    target_utc = booking_start - timedelta(milliseconds=PREFIRE_MS)
    seconds_until = (target_utc - now_utc).total_seconds()
    log_debug(
        "prefire_timing",
        now_utc=now_utc.isoformat(),
        booking_start_utc=booking_start.isoformat(),
        prefire_target_utc=target_utc.isoformat(),
        seconds_until_prefire=round(seconds_until, 6),
        prefire_ms=PREFIRE_MS,
        window_ms=WINDOW_MS,
    )

    if seconds_until > 90:
        print(
            f"Too early. Booking opens in {seconds_until:.2f} seconds "
            "(to prefire point). Exiting."
        )
        return False

    print(f"Entering final busy wait loop... (prefire {PREFIRE_MS} ms before)")
    # Sleep for the bulk to save CPU, then busy-wait for the final 2 seconds
    if seconds_until > 2:
        time.sleep(seconds_until - 2)
    target_time = time.perf_counter() + min(seconds_until, 2)
    while time.perf_counter() < target_time:
        pass
    return True


async def try_add_to_cart(session, booking_id):
    """Send a single add-to-cart request. No concurrent shots — multiple in-flight
    requests corrupt the server-side cart and cause book-from-cart to find it empty."""
    url = f"{BASE_URL}/api/cart/add-to-cart-palapa/{booking_id}"
    payload = {
        "slot": 1,
        "email": "",
        "name": "",
        "number_chairs": None,
        "fullday_booked": 1,
        "menuitems": None,
        "discounts": {},
    }

    MAX_CART_ATTEMPTS = 3
    for attempt in range(MAX_CART_ATTEMPTS):
        sent_at = datetime.utcnow()
        attempt_perf = time.perf_counter()
        try:
            async with session.post(url, json=payload) as resp:
                text = await resp.text()
                received_at = datetime.utcnow()
                rtt_ms = (time.perf_counter() - attempt_perf) * 1000
                print(
                    f"Add-to-cart attempt {attempt + 1} SENT at {sent_at.isoformat()} - "
                    f"RESPONSE {resp.status} at {received_at.isoformat()} - "
                    f"Date: {resp.headers.get('Date')}"
                )
                print(f"Add-to-cart attempt {attempt + 1} response: {text[:300]}")

                parsed = {}
                try:
                    parsed = json.loads(text)
                except json.JSONDecodeError:
                    pass

                log_debug(
                    "add_to_cart_attempt",
                    attempt=attempt + 1,
                    booking_id=booking_id,
                    status=resp.status,
                    rtt_ms=round(rtt_ms, 2),
                    sent_at=sent_at.isoformat(),
                    received_at=received_at.isoformat(),
                    response_date=resp.headers.get("Date"),
                    success=parsed.get("success"),
                    message=parsed.get("message"),
                    booking=summarize_booking(parsed.get("booking") or {}),
                    anonymous_id=parsed.get("anonymous_id"),
                    response_preview=response_preview(text),
                )

                if is_successful_response(text):
                    print(f"Add-to-cart succeeded on attempt {attempt + 1}.")
                    return {
                        "shot_id": attempt,
                        "status": resp.status,
                        "text": text,
                        "sent_at": sent_at,
                        "received_at": received_at,
                    }

                msg = str(parsed.get("message", "")).lower()
                if "not available" in msg or "already booked" in msg:
                    print(f"Booking {booking_id} is no longer available.")
                    return None

        except Exception as e:
            print(f"Add-to-cart attempt {attempt + 1} failed: {e}")
            log_debug("add_to_cart_exception", attempt=attempt + 1,
                      booking_id=booking_id, error=str(e))

    print(f"Add-to-cart exhausted after {MAX_CART_ATTEMPTS} attempts.")
    log_debug("add_to_cart_exhausted", booking_id=booking_id, attempts=MAX_CART_ATTEMPTS)
    return None


async def try_reserve_booking(session, booking_id, room_number="", anonymous_id=None):
    """Fire concurrent reserve requests in staggered waves.

    Reserve is idempotent — the server returns the current slot state regardless
    of how many times we call it.  By keeping multiple requests in-flight we
    ensure one arrives at the server within ~STAGGER_MS of the booking window
    opening, rather than waiting a full round-trip between each attempt.

    Pre-window responses (slot1_status=1, no owner) are discarded so the burst
    continues until the window actually opens or the deadline expires.
    """
    url = f"{BASE_URL}/api/palapa/booking/reserve"
    params = {
        "booking_id": booking_id,
        "slot": 1,
        "keep_price": 1,
        "multi_select": 0,
        "reservation_no": "",
        "room_number": room_number or "",
    }

    RESERVE_IN_FLIGHT = 5       # concurrent requests at any moment
    STAGGER_MS = 15             # ms between launching each request
    deadline = time.perf_counter() + (PREFIRE_MS + WINDOW_MS) / 1000.0

    result = None               # first successful reserve response
    owned_by_other = False      # flag: slot taken by someone else
    attempt_counter = 0
    active_tasks = set()

    async def _fire(shot_id):
        nonlocal result, owned_by_other

        sent_at = datetime.utcnow()
        shot_perf = time.perf_counter()
        try:
            async with session.get(url, params=params) as resp:
                received_at = datetime.utcnow()
                text = await resp.text()
                rtt_ms = (time.perf_counter() - shot_perf) * 1000
                print(
                    f"Reserve attempt {shot_id} SENT at {sent_at.isoformat()} - "
                    f"RESPONSE {resp.status} at {received_at.isoformat()} - "
                    f"Date: {resp.headers.get('Date')}"
                )
                print(f"Reserve attempt {shot_id} response: {text[:300]}")

                try:
                    data = json.loads(text)
                except json.JSONDecodeError:
                    log_debug("reserve_attempt_non_json", attempt=shot_id,
                              booking_id=booking_id, status=resp.status,
                              rtt_ms=round(rtt_ms, 2),
                              response_preview=response_preview(text))
                    return

                booking = data.get("booking") or {}
                log_debug(
                    "reserve_attempt",
                    attempt=shot_id, booking_id=booking_id,
                    status=resp.status, rtt_ms=round(rtt_ms, 2),
                    sent_at=sent_at.isoformat(),
                    received_at=received_at.isoformat(),
                    response_date=resp.headers.get("Date"),
                    success=data.get("success"),
                    message=data.get("message"),
                    booking=summarize_booking(booking),
                    response_preview=response_preview(text),
                )

                if data.get("success") != "ok" or booking.get("id") != booking_id:
                    return

                slot_status = booking.get("slot1_status")
                slot_owner = booking.get("slot1_booked_user_id")

                # Pre-window: slot still open, window hasn't started.
                if slot_status in (None, 1) and not slot_owner:
                    log_debug("reserve_pre_window", attempt=shot_id,
                              booking_id=booking_id, slot1_status=slot_status)
                    return

                # Another session owns this slot.
                if slot_owner and anonymous_id and slot_owner != anonymous_id:
                    print(
                        f"Reserve returned ok but slot owned by {slot_owner[:8]}… "
                        f"(ours: {anonymous_id[:8]}…); skipping."
                    )
                    log_debug("reserve_owned_by_other", booking_id=booking_id,
                              slot_owner=slot_owner, anonymous_id=anonymous_id,
                              slot1_status=slot_status)
                    owned_by_other = True
                    return

                # We got the reservation.
                if result is None:
                    result = {
                        "attempt": shot_id,
                        "status": resp.status,
                        "text": text,
                        "sent_at": sent_at,
                        "received_at": received_at,
                    }
        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"Reserve attempt {shot_id} failed: {e}")
            log_debug("reserve_attempt_exception", attempt=shot_id,
                      booking_id=booking_id, error=str(e),
                      traceback=traceback.format_exc())

    # Main dispatch loop — keeps RESERVE_IN_FLIGHT requests in the air
    while time.perf_counter() < deadline and result is None and not owned_by_other:
        # Reap completed tasks
        done = {t for t in active_tasks if t.done()}
        active_tasks -= done

        # Launch new requests up to the concurrency cap
        while len(active_tasks) < RESERVE_IN_FLIGHT and time.perf_counter() < deadline:
            attempt_counter += 1
            task = asyncio.ensure_future(_fire(attempt_counter))
            active_tasks.add(task)
            # Stagger launches so they arrive at slightly different server times
            await asyncio.sleep(STAGGER_MS / 1000.0)
            if result is not None or owned_by_other:
                break

        # Brief yield to let in-flight responses land
        if active_tasks and result is None and not owned_by_other:
            await asyncio.sleep(0.005)

    # Cancel stragglers
    for task in active_tasks:
        task.cancel()
    if active_tasks:
        await asyncio.gather(*active_tasks, return_exceptions=True)

    if result:
        print(f"Reserve succeeded on attempt {result['attempt']}.")
        return result
    if owned_by_other:
        return None

    print(f"Could not reserve booking {booking_id}. Attempts: {attempt_counter}.")
    log_debug("reserve_exhausted", booking_id=booking_id, attempts=attempt_counter)
    return None


async def main(event, context):
    event = event or {}
    debug_token = DEBUG_LOGGING.set(DEBUG_LOGGING.get() or bool(event.get("debug_mode")))
    start_time = datetime.utcnow()
    session = None
    log_debug(
        "lambda_start",
        event=redact_mapping(event),
        context_request_id=getattr(context, "aws_request_id", None),
        function_name=getattr(context, "function_name", None),
        tuning={
            "prefire_ms": PREFIRE_MS,
            "window_ms": WINDOW_MS,
            "max_shots": MAX_SHOTS,
            "max_in_flight": MAX_IN_FLIGHT,
        },
        utc_now=start_time.isoformat(),
        local_now=datetime.now(LOCAL_TZ).isoformat(),
    )
    try:
        profile = resolve_profile(event)
        payload_body = await create_payload(profile)
        hut_choices = resolve_hut_choices(event)
        if not hut_choices:
            print("No hut_number or hut_choices provided; aborting.")
            log_debug("lambda_exit_no_hut", event_keys=list(event.keys()))
            return
        log_debug(
            "profile_resolved",
            profile=redact_mapping(profile),
            hut_choices=hut_choices,
        )

        session, csrf_token, anonymous_id = await initialize_session()

        # Resolve booking_date early; if the event has it (schedules always do),
        # we can fetch palapas and bookings in parallel.
        explicit_book_date = event.get("book_date")

        if explicit_book_date:
            booking_date = str(explicit_book_date)
            try:
                (p_status, p_text, _), (b_status, b_text, _) = await asyncio.gather(
                    request_text(session, "post", f"{BASE_URL}/api/palapa/get-palapas",
                                 "get-palapas", json={"seating_name": None}),
                    request_text(session, "post",
                                 f"{BASE_URL}/api/palapa/booking/get-auto-update-bookings/1",
                                 "get-auto-update-bookings", json={"book_date": booking_date}),
                )
                palapas = json.loads(p_text).get("palapas", [])
                bookings = json.loads(b_text).get("bookings", [])
                log_debug("parallel_fetch", palapas_count=len(palapas), bookings_count=len(bookings))
            except Exception as e:
                print(f"Failed to fetch palapas/bookings: {e}")
                log_debug("parallel_fetch_failed", error=str(e), traceback=traceback.format_exc())
                return
        else:
            # Fallback: sequential fetch (need palapas first to determine date)
            try:
                status, text, _ = await request_text(
                    session, "post", f"{BASE_URL}/api/palapa/get-palapas",
                    "get-palapas", json={"seating_name": None},
                )
                palapas = json.loads(text).get("palapas", [])
            except Exception as e:
                print(f"Failed to get palapas: {e}")
                log_debug("palapas_failed", error=str(e), traceback=traceback.format_exc())
                return

            primary_palapa = next(
                (p for p in palapas if str(p.get("name")) == str(hut_choices[0])), None,
            )
            palapatype_for_date = (primary_palapa or {}).get("palapatype_name", "")
            booking_date = resolve_book_date(event, palapatype_for_date)

            try:
                status, text, _ = await request_text(
                    session, "post",
                    f"{BASE_URL}/api/palapa/booking/get-auto-update-bookings/1",
                    "get-auto-update-bookings", json={"book_date": booking_date},
                )
                bookings = json.loads(text).get("bookings", [])
            except Exception as e:
                print(f"Failed to get bookings: {e}")
                log_debug("bookings_failed", error=str(e), traceback=traceback.format_exc())
                return

        print("Target booking_date:", booking_date)
        log_debug("booking_date_resolved", booking_date=booking_date, primary_hut=hut_choices[0])

        bookings_by_palapa = {b.get("palapa_id"): b for b in bookings}

        # Pick the booking_start time from the first candidate that exists (they
        # all open at the same advanced_booking_time, but we fall back safely).
        first_existing_booking = None
        for hut in hut_choices:
            _, bkg = select_booking_for_hut(palapas, bookings_by_palapa, hut)
            if bkg:
                first_existing_booking = bkg
                break
        if not first_existing_booking:
            print("None of the requested huts had a booking record; aborting.")
            log_debug("lambda_exit_no_booking_record", hut_choices=hut_choices)
            return

        booking_time = first_existing_booking.get("advanced_booking_time", "07:00")
        booking_time_str = f"{datetime.now(LOCAL_TZ).strftime('%Y-%m-%d')} {booking_time}"
        naive_local_dt = datetime.strptime(booking_time_str, "%Y-%m-%d %H:%M")
        localized_dt = LOCAL_TZ.localize(naive_local_dt)
        booking_start = localized_dt.astimezone(pytz.utc)
        print("Booking opens at UTC:", booking_start.isoformat())

        await request_text(session, "post", f"{BASE_URL}/api/cart/user-cart", "cart-before", json={})
        if not wait_until_prefire(booking_start):
            log_debug("lambda_exit_too_early", hut_choices=hut_choices)
            return

        # Pre-flight re-check: fetch fresh booking statuses right before firing
        try:
            _, preflight_text, _ = await request_text(
                session,
                "post",
                f"{BASE_URL}/api/palapa/booking/get-auto-update-bookings/1",
                "preflight-bookings",
                json={"book_date": booking_date},
            )
            fresh_bookings = json.loads(preflight_text).get("bookings", [])
            bookings_by_palapa = {b.get("palapa_id"): b for b in fresh_bookings}
            log_debug(
                "preflight_bookings_refreshed",
                booking_date=booking_date,
                count=len(fresh_bookings),
            )
        except Exception as e:
            print(f"Pre-flight refresh failed, using stale data: {e}")
            log_debug("preflight_refresh_failed", error=str(e))

        book_time = datetime.utcnow()
        log_debug("booking_attempt_start", hut_choices=hut_choices, book_time_utc=book_time.isoformat())

        MAX_CONFIRM_RETRIES = 3
        confirmed = False
        selected_hut = None
        selected_booking_id = None
        confirm_text = ""
        cart_text = ""

        for idx, hut in enumerate(hut_choices):
            palapa, booking = select_booking_for_hut(palapas, bookings_by_palapa, hut)
            if not palapa:
                print(f"Hut {hut} not found in palapa list; skipping.")
                log_debug("hut_skipped", hut=hut, reason="palapa_not_found", priority=idx)
                continue
            if not booking_is_viable(booking):
                print(f"Hut {hut} not viable (status={booking.get('status') if booking else 'n/a'}); skipping.")
                log_debug(
                    "hut_skipped",
                    hut=hut,
                    reason="not_viable",
                    priority=idx,
                    booking=summarize_booking(booking or {}),
                )
                continue

            booking_id = booking.get("id")
            log_debug(
                "target_booking_selected",
                priority=idx,
                hut=hut,
                booking=summarize_booking(booking),
                booking_time=booking.get("advanced_booking_time"),
            )

            # Retry reserve → add-to-cart → book-from-cart if cart times out
            for retry in range(MAX_CONFIRM_RETRIES):
                reserve_attempt = await try_reserve_booking(session, booking_id, room_number=profile.get("room", ""), anonymous_id=anonymous_id)
                if not reserve_attempt:
                    print(f"Could not reserve hut {hut}; trying next backup.")
                    log_debug("reserve_failed_trying_next", hut=hut, priority=idx, retry=retry)
                    break

                cart_attempt = await try_add_to_cart(session, booking_id)
                if not cart_attempt:
                    print(f"Add-to-cart failed for hut {hut}; trying next backup.")
                    log_debug("cart_failed_trying_next", hut=hut, priority=idx, retry=retry)
                    break

                # Immediately confirm — minimize gap between add-to-cart and checkout
                confirm_perf = time.perf_counter()
                confirm_sent_at = datetime.utcnow()
                status, c_text, confirm_headers = await request_text(
                    session,
                    "post",
                    f"{BASE_URL}/api/cart/book-from-cart",
                    "book-from-cart",
                    headers={"X-CSRFToken": csrf_token or ""},
                    json=payload_body,
                )
                confirm_rtt_ms = (time.perf_counter() - confirm_perf) * 1000
                try:
                    confirm_json = json.loads(c_text)
                except json.JSONDecodeError:
                    confirm_json = {}
                log_debug(
                    "book_from_cart_result",
                    status=status,
                    rtt_ms=round(confirm_rtt_ms, 2),
                    sent_at=confirm_sent_at.isoformat(),
                    received_at=datetime.utcnow().isoformat(),
                    response_date=confirm_headers.get("Date"),
                    success=confirm_json.get("success"),
                    message=confirm_json.get("message"),
                    booking_id=booking_id,
                    hut=hut,
                    retry=retry,
                    response_preview=response_preview(c_text),
                )

                if confirm_json.get("success") == "ok":
                    confirmed = True
                    selected_hut = hut
                    selected_booking_id = booking_id
                    confirm_text = c_text
                    cart_text = cart_attempt["text"]
                    break

                # Cart timeout — retry the full reserve→cart→confirm cycle
                msg = str(confirm_json.get("message", "")).lower()
                if "timeout" in msg or "nothing in your cart" in msg:
                    print(f"Cart timed out for hut {hut} (retry {retry + 1}/{MAX_CONFIRM_RETRIES})")
                    log_debug("cart_timeout_retry", hut=hut, retry=retry, message=msg)
                    continue

                # Some other confirm error — move to next hut
                print(f"Confirm failed for hut {hut}: {confirm_json.get('message', 'unknown')}")
                break

            if confirmed:
                log_debug("hut_selected", hut=hut, priority=idx, booking_id=booking_id)
                break

        if not confirmed:
            print("Exhausted all hut choices without a successful booking.")
            log_debug("lambda_exit_no_hut_succeeded", hut_choices=hut_choices)
            if profile.get("sms_enabled"):
                notify_phone = profile.get("notification_phone", "")
                await send_sms_notification(
                    f"Palapa booking FAILED for {booking_date}. "
                    f"All {len(hut_choices)} hut(s) were taken: {', '.join(hut_choices)}",
                    notify_phone,
                )
            return

        # Parse confirmation details
        try:
            confirm_data = json.loads(confirm_text)
        except json.JSONDecodeError:
            confirm_data = {}
        order_number = confirm_data.get("order_number", "")

        # Post-booking verification: re-fetch bookings and confirm status changed
        # status=2 (registered user) or status=50 (anonymous/cart) both mean booked
        verified = False
        manage_url = ""
        try:
            _, verify_text, _ = await request_text(
                session,
                "post",
                f"{BASE_URL}/api/palapa/booking/get-auto-update-bookings/1",
                "verify-bookings",
                json={"book_date": booking_date},
            )
            verify_bookings = json.loads(verify_text).get("bookings", [])
            for vb in verify_bookings:
                if vb.get("id") == selected_booking_id:
                    vb_status = vb.get("status")
                    verified = vb_status in (2, 50)
                    print(
                        f"VERIFICATION: Hut {selected_hut} booking {selected_booking_id} "
                        f"status={vb_status} ({'CONFIRMED' if verified else 'NOT CONFIRMED'})"
                    )
                    log_debug(
                        "booking_verified",
                        hut=selected_hut,
                        booking_id=selected_booking_id,
                        status=vb_status,
                        verified=verified,
                        order_number=order_number,
                        booking=summarize_booking(vb),
                    )
                    break
            else:
                print(f"VERIFICATION: Booking {selected_booking_id} not found in bookings list.")
        except Exception as e:
            print(f"Post-booking verification failed: {e}")
            log_debug("verify_failed", error=str(e))

        # Build management link from the add-to-cart response (has slot1_transaction_at)
        slot1_txn_at = ""
        booked_email = profile.get("email", "")
        if booked_email and cart_text:
            try:
                cart_data = json.loads(cart_text)
                cart_booking = cart_data.get("booking") or {}
                slot1_txn_at = cart_booking.get("slot1_transaction_at") or ""
                if slot1_txn_at:
                    txn_clean = slot1_txn_at.replace("Z", "+00:00")
                    txn_dt = datetime.fromisoformat(txn_clean)
                    txn_str = txn_dt.strftime("%Y-%m-%d %H:%M:%S")
                    token = base64.b64encode(
                        f"{booked_email}|{txn_str}".encode()
                    ).decode().rstrip("=")
                    manage_url = f"{BASE_URL}/api/auth/login-user-from-email/{token}"
                    print(f"Management link: {manage_url}")
                    log_debug("management_link", manage_url=manage_url)
            except Exception as e:
                print(f"Could not build management link: {e}")

        # Persist booking result to DynamoDB
        save_booking_result(
            event, profile, booking_date, selected_hut,
            ipoolside_booking_id=str(selected_booking_id),
            order_number=order_number,
            verified=verified,
            manage_url=manage_url,
            slot1_transaction_at=slot1_txn_at,
        )

        # SMS notification on success
        if profile.get("sms_enabled"):
            notify_phone = profile.get("notification_phone", "")
            sms_body = f"Palapa booked! Hut {selected_hut} for {booking_date}."
            if order_number:
                sms_body += f" Order: {order_number}"
            if not verified:
                sms_body += " (unverified — check iPoolside)"
            if manage_url:
                sms_body += f"\nManage: {manage_url}"
            await send_sms_notification(sms_body, notify_phone)

        end_time = datetime.utcnow()
        print("Book time:", (end_time - book_time).total_seconds())
        print("Total time:", (end_time - start_time).total_seconds())
        if order_number:
            print(f"Order number: {order_number}")
        print(f"Booking confirmed: {verified}")
        print("Response:", confirm_text[:300])
        print("Cart Add Response:", cart_text[:300])
        log_debug(
            "lambda_complete",
            booking_id=selected_booking_id,
            hut=selected_hut,
            hut_choices=hut_choices,
            order_number=order_number,
            verified=verified,
            book_time_seconds=(end_time - book_time).total_seconds(),
            total_time_seconds=(end_time - start_time).total_seconds(),
        )
    except Exception as e:
        log_debug("lambda_exception", error=str(e), traceback=traceback.format_exc())
        raise
    finally:
        if session is not None:
            await session.close()
            log_debug("session_closed")
        DEBUG_LOGGING.reset(debug_token)


def lambda_handler(event, context):
    print(event)
    asyncio.run(main(event, context))
