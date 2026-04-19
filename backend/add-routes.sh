#!/usr/bin/env bash
#
# Clone one or more routes onto the existing palapa API using the target of a
# known reference route (GET /bookings by default). Intended for adding the new
# profile/book-now routes introduced by the real-profile workflow.
#
# Usage:
#   ./add-routes.sh
#   NEW_ROUTE_KEYS="GET /profile,PATCH /profile,POST /bookings/now" ./add-routes.sh

set -euo pipefail

API_ID="${API_ID:-zaeea3e7s0}"
REGION="${AWS_REGION:-us-east-1}"
SOURCE_ROUTE_KEY="${SOURCE_ROUTE_KEY:-GET /bookings}"
NEW_ROUTE_KEYS="${NEW_ROUTE_KEYS:-GET /profile,PATCH /profile,POST /bookings/now}"

target="$(aws apigatewayv2 get-routes \
  --api-id "$API_ID" \
  --region "$REGION" \
  --query "Items[?RouteKey=='$SOURCE_ROUTE_KEY'].Target | [0]" \
  --output text)"

authorization_type="$(aws apigatewayv2 get-routes \
  --api-id "$API_ID" \
  --region "$REGION" \
  --query "Items[?RouteKey=='$SOURCE_ROUTE_KEY'].AuthorizationType | [0]" \
  --output text)"

authorizer_id="$(aws apigatewayv2 get-routes \
  --api-id "$API_ID" \
  --region "$REGION" \
  --query "Items[?RouteKey=='$SOURCE_ROUTE_KEY'].AuthorizerId | [0]" \
  --output text)"

if [[ "$target" == "None" || -z "$target" ]]; then
  echo "Could not find source route target for $SOURCE_ROUTE_KEY" >&2
  exit 1
fi

IFS=',' read -ra ROUTES <<< "$NEW_ROUTE_KEYS"
for raw_key in "${ROUTES[@]}"; do
  NEW_ROUTE_KEY="$(echo "$raw_key" | awk '{$1=$1;print}')"
  [[ -z "$NEW_ROUTE_KEY" ]] && continue

  existing_route_id="$(aws apigatewayv2 get-routes \
    --api-id "$API_ID" \
    --region "$REGION" \
    --query "Items[?RouteKey=='$NEW_ROUTE_KEY'].RouteId | [0]" \
    --output text)"

  if [[ "$existing_route_id" != "None" && -n "$existing_route_id" ]]; then
    echo "$NEW_ROUTE_KEY already exists as route $existing_route_id"
    continue
  fi

  create_args=(
    apigatewayv2 create-route
    --api-id "$API_ID"
    --region "$REGION"
    --route-key "$NEW_ROUTE_KEY"
    --target "$target"
  )

  if [[ "$authorization_type" != "None" && "$authorization_type" != "NONE" && -n "$authorization_type" ]]; then
    create_args+=(--authorization-type "$authorization_type")
  fi

  if [[ "$authorizer_id" != "None" && -n "$authorizer_id" ]]; then
    create_args+=(--authorizer-id "$authorizer_id")
  fi

  aws "${create_args[@]}"
  echo "Created $NEW_ROUTE_KEY using target $target"
done
