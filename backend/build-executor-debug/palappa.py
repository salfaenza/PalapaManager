import asyncio
import json
import os
import time
import traceback
from contextvars import ContextVar
from datetime import datetime, timedelta

import aiohttp
import pytz


# Tuning parameters
PREFIRE_MS = 500
WINDOW_MS = 400
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


def _profiles_table():
    """Return a boto3 DDB Table for profile lookups. Imported lazily so unit tests
    that don't need AWS don't blow up."""
    import boto3
    return boto3.resource("dynamodb").Table(PROFILES_TABLE_NAME)


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
    return {
        "first": first,
        "last": last,
        "name": name,
        "email": prefer("email") or profile_email or "",
        "phone": prefer("phone"),
        "room": prefer("room"),
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
    await request_text(
        session,
        "get",
        f"{BASE_URL}/api/translations/translations?language=en&return_as=dict",
        "translations",
    )
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
    log_debug(
        "session_initialized",
        csrf_source="login-session" if login_data.get("csrf_token") else "cookie",
        csrf_present=bool(csrf),
        csrf_length=len(csrf or ""),
        cookie_names=sorted({cookie.key for cookie in session.cookie_jar}),
        max_in_flight=MAX_IN_FLIGHT,
    )
    return session, csrf


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

    if seconds_until > 60:
        print(
            f"Too early. Booking opens in {seconds_until:.2f} seconds "
            "(to prefire point). Exiting."
        )
        return False

    print(f"Entering final busy wait loop... (prefire {PREFIRE_MS} ms before)")
    target_time = time.perf_counter() + seconds_until
    while time.perf_counter() < target_time:
        pass
    return True


async def try_add_to_cart(session, booking_id):
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

    result = None
    shot_counter = 0
    unavail_count = 0
    EARLY_EXIT_THRESHOLD = 5
    active_tasks = set()
    fire_deadline = time.perf_counter() + (PREFIRE_MS + WINDOW_MS) / 1000.0

    async def shoot(shot_id):
        nonlocal result, unavail_count

        try:
            fire_time = datetime.utcnow()
            shot_perf = time.perf_counter()
            async with session.post(url, json=payload) as resp:
                recv_time = datetime.utcnow()
                text = await resp.text()
                rtt_ms = (time.perf_counter() - shot_perf) * 1000
                headers_date = resp.headers.get("Date")
                print(
                    f"Shot {shot_id} SENT at {fire_time.isoformat()} - "
                    f"RESPONSE {resp.status} at {recv_time.isoformat()} - "
                    f"Date: {headers_date}"
                )
                print(f"Shot {shot_id} response: {text[:300]}")
                parsed = {}
                try:
                    parsed = json.loads(text)
                except json.JSONDecodeError:
                    parsed = {}
                log_debug(
                    "add_to_cart_shot",
                    shot_id=shot_id,
                    booking_id=booking_id,
                    status=resp.status,
                    rtt_ms=round(rtt_ms, 2),
                    sent_at=fire_time.isoformat(),
                    received_at=recv_time.isoformat(),
                    response_date=headers_date,
                    success=parsed.get("success"),
                    message=parsed.get("message"),
                    booking=summarize_booking(parsed.get("booking") or {}),
                    anonymous_id=parsed.get("anonymous_id"),
                    response_preview=response_preview(text),
                )

                if result is None and is_successful_response(text):
                    unavail_count = 0
                    result = {
                        "shot_id": shot_id,
                        "status": resp.status,
                        "text": text,
                        "sent_at": fire_time,
                        "received_at": recv_time,
                    }
                elif result is None:
                    msg = str(parsed.get("message", "")).lower()
                    if "not available" in msg or "already booked" in msg:
                        unavail_count += 1
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"Shot {shot_id} failed: {e}")

    async def cart_contains_booking():
        try:
            status, text, _ = await request_text(
                session,
                "post",
                f"{BASE_URL}/api/cart/user-cart",
                "cart-verify",
                json={},
            )
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                print(f"Cart verification returned non-JSON response: {text[:300]}")
                return None

            log_debug(
                "cart_verify_result",
                booking_id=booking_id,
                cart_booking_count=len(data.get("bookings", [])),
                cart_booking_ids=[b.get("id") for b in data.get("bookings", [])],
            )
            for booking in data.get("bookings", []):
                if booking.get("id") == booking_id:
                    return {
                        "shot_id": "cart-verify",
                        "status": status,
                        "text": text,
                        "sent_at": datetime.utcnow(),
                        "received_at": datetime.utcnow(),
                    }
            print(f"Cart verification found no booking {booking_id}.")
            return None
        except Exception as e:
            print(f"Cart verification failed: {e}")
            return None

    while (
        result is None
        and unavail_count < EARLY_EXIT_THRESHOLD
        and (
            active_tasks
            or (shot_counter < MAX_SHOTS and time.perf_counter() < fire_deadline)
        )
    ):
        while (
            result is None
            and unavail_count < EARLY_EXIT_THRESHOLD
            and len(active_tasks) < MAX_IN_FLIGHT
            and shot_counter < MAX_SHOTS
            and time.perf_counter() < fire_deadline
        ):
            task = asyncio.create_task(shoot(shot_counter))
            active_tasks.add(task)
            shot_counter += 1

        if not active_tasks:
            break

        done, active_tasks = await asyncio.wait(
            active_tasks,
            return_when=asyncio.FIRST_COMPLETED,
        )
        await asyncio.gather(*done, return_exceptions=True)

    if unavail_count >= EARLY_EXIT_THRESHOLD and result is None:
        for task in active_tasks:
            task.cancel()
        await asyncio.gather(*active_tasks, return_exceptions=True)
        print(
            f"Early exit: {unavail_count} consecutive 'not available' responses. "
            f"Shots fired: {shot_counter}."
        )
        log_debug(
            "add_to_cart_early_exit",
            booking_id=booking_id,
            unavail_count=unavail_count,
            shots_started=shot_counter,
        )
        return None

    if result is not None:
        for task in active_tasks:
            task.cancel()
        await asyncio.gather(*active_tasks, return_exceptions=True)
        print(
            f"Got a successful add-to-cart shot "
            f"{result['shot_id']} at {result['received_at'].isoformat()}!"
        )
        return result

    if active_tasks:
        await asyncio.gather(*active_tasks, return_exceptions=True)

    verified_result = await cart_contains_booking()
    if verified_result is not None:
        print("Verified target booking is in cart after add-to-cart responses.")
        return verified_result

    print(f"All shots exhausted; no success. Shots started: {shot_counter}.")
    log_debug(
        "add_to_cart_exhausted",
        booking_id=booking_id,
        shots_started=shot_counter,
        max_shots=MAX_SHOTS,
        max_in_flight=MAX_IN_FLIGHT,
    )
    return None


async def try_reserve_booking(session, booking_id, room_number=""):
    url = f"{BASE_URL}/api/palapa/booking/reserve"
    params = {
        "booking_id": booking_id,
        "slot": 1,
        "keep_price": 1,
        "multi_select": 0,
        "reservation_no": "",
        "room_number": room_number or "",
    }
    deadline = time.perf_counter() + (PREFIRE_MS + WINDOW_MS) / 1000.0
    attempt = 0

    while time.perf_counter() < deadline:
        attempt += 1
        sent_at = datetime.utcnow()
        attempt_perf = time.perf_counter()
        try:
            async with session.get(url, params=params) as resp:
                received_at = datetime.utcnow()
                text = await resp.text()
                rtt_ms = (time.perf_counter() - attempt_perf) * 1000
                print(
                    f"Reserve attempt {attempt} SENT at {sent_at.isoformat()} - "
                    f"RESPONSE {resp.status} at {received_at.isoformat()} - "
                    f"Date: {resp.headers.get('Date')}"
                )
                print(f"Reserve attempt {attempt} response: {text[:300]}")

                try:
                    data = json.loads(text)
                except json.JSONDecodeError:
                    log_debug(
                        "reserve_attempt_non_json",
                        attempt=attempt,
                        booking_id=booking_id,
                        status=resp.status,
                        rtt_ms=round(rtt_ms, 2),
                        response_preview=response_preview(text),
                    )
                    continue

                booking = data.get("booking") or {}
                log_debug(
                    "reserve_attempt",
                    attempt=attempt,
                    booking_id=booking_id,
                    status=resp.status,
                    rtt_ms=round(rtt_ms, 2),
                    sent_at=sent_at.isoformat(),
                    received_at=received_at.isoformat(),
                    response_date=resp.headers.get("Date"),
                    success=data.get("success"),
                    message=data.get("message"),
                    booking=summarize_booking(booking),
                    response_preview=response_preview(text),
                )
                if data.get("success") == "ok" and booking.get("id") == booking_id:
                    return {
                        "attempt": attempt,
                        "status": resp.status,
                        "text": text,
                        "sent_at": sent_at,
                        "received_at": received_at,
                    }
        except Exception as e:
            print(f"Reserve attempt {attempt} failed: {e}")
            log_debug(
                "reserve_attempt_exception",
                attempt=attempt,
                booking_id=booking_id,
                error=str(e),
                traceback=traceback.format_exc(),
            )

    print(f"Could not reserve booking {booking_id}. Attempts: {attempt}.")
    log_debug("reserve_exhausted", booking_id=booking_id, attempts=attempt)
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

        session, csrf_token = await initialize_session()

        try:
            status, text, _ = await request_text(
                session,
                "post",
                f"{BASE_URL}/api/palapa/get-palapas",
                "get-palapas",
                json={"seating_name": None},
            )
            palapas = json.loads(text).get("palapas", [])
            log_debug("palapas_loaded", status=status, count=len(palapas))
        except Exception as e:
            print(f"Failed to get palapas: {e}")
            log_debug("palapas_failed", error=str(e), traceback=traceback.format_exc())
            return

        # Use the first known palapa type to decide the booking_date, with event override.
        primary_palapa = next(
            (p for p in palapas if str(p.get("name")) == str(hut_choices[0])),
            None,
        )
        palapatype_for_date = (primary_palapa or {}).get("palapatype_name", "")
        booking_date = resolve_book_date(event, palapatype_for_date)
        print("Target booking_date:", booking_date)
        log_debug(
            "booking_date_resolved",
            booking_date=booking_date,
            palapatype=palapatype_for_date,
            primary_hut=hut_choices[0],
        )

        try:
            status, text, _ = await request_text(
                session,
                "post",
                f"{BASE_URL}/api/palapa/booking/get-auto-update-bookings/1",
                "get-auto-update-bookings",
                json={"book_date": booking_date},
            )
            bookings = json.loads(text).get("bookings", [])
            status_counts = {}
            for item in bookings:
                status_key = str(item.get("status"))
                status_counts[status_key] = status_counts.get(status_key, 0) + 1
            log_debug(
                "bookings_loaded",
                status=status,
                booking_date=booking_date,
                count=len(bookings),
                status_counts=status_counts,
            )
        except Exception as e:
            print(f"Failed to get bookings: {e}")
            log_debug("bookings_failed", error=str(e), traceback=traceback.format_exc())
            return

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

        # Iterate primary + backups in priority order, attempting reserve then add-to-cart.
        reserve_result = None
        cart_result = None
        selected_hut = None
        selected_booking_id = None

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
            reserve_attempt = await try_reserve_booking(session, booking_id, room_number=profile.get("room", ""))
            if not reserve_attempt:
                print(f"Could not reserve hut {hut}; trying next backup.")
                log_debug("reserve_failed_trying_next", hut=hut, priority=idx)
                continue
            cart_attempt = await try_add_to_cart(session, booking_id)
            if not cart_attempt:
                print(f"Reserve succeeded but add-to-cart failed for hut {hut}; trying next backup.")
                log_debug("cart_failed_trying_next", hut=hut, priority=idx)
                continue

            reserve_result = reserve_attempt
            cart_result = cart_attempt
            selected_hut = hut
            selected_booking_id = booking_id
            log_debug("hut_selected", hut=hut, priority=idx, booking_id=booking_id)
            break

        if not reserve_result or not cart_result:
            print("Exhausted all hut choices without a successful reserve+cart.")
            log_debug("lambda_exit_no_hut_succeeded", hut_choices=hut_choices)
            return

        confirm_perf = time.perf_counter()
        confirm_sent_at = datetime.utcnow()
        status, confirm_text, confirm_headers = await request_text(
            session,
            "post",
            f"{BASE_URL}/api/cart/book-from-cart",
            "book-from-cart",
            headers={"X-CSRFToken": csrf_token or ""},
            json=payload_body,
        )
        confirm_received_at = datetime.utcnow()
        confirm_rtt_ms = (time.perf_counter() - confirm_perf) * 1000
        try:
            confirm_json = json.loads(confirm_text)
        except json.JSONDecodeError:
            confirm_json = {}
        log_debug(
            "book_from_cart_result",
            status=status,
            rtt_ms=round(confirm_rtt_ms, 2),
            sent_at=confirm_sent_at.isoformat(),
            received_at=confirm_received_at.isoformat(),
            response_date=confirm_headers.get("Date"),
            success=confirm_json.get("success"),
            message=confirm_json.get("message"),
            booking_id=selected_booking_id,
            hut=selected_hut,
            response_preview=response_preview(confirm_text),
        )

        end_time = datetime.utcnow()
        print("Book time:", (end_time - book_time).total_seconds())
        print("Total time:", (end_time - start_time).total_seconds())
        print("Response:", confirm_text[:300])
        print("Cart Add Response:", cart_result["text"][:300])
        log_debug(
            "lambda_complete",
            booking_id=selected_booking_id,
            hut=selected_hut,
            hut_choices=hut_choices,
            reserve_attempt=reserve_result.get("attempt"),
            add_to_cart_shot=cart_result.get("shot_id"),
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
