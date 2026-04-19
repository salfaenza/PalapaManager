#!/usr/bin/env bash
set -euo pipefail

aws dynamodb batch-write-item --request-items '{
  "palapa-users": [
    {"PutRequest": {"Item": {"email": {"S": "sfaenza10@gmail.com"}, "role": {"S": "admin"}}}},
    {"PutRequest": {"Item": {"email": {"S": "rdilouie@gmail.com"}, "role": {"S": "user"}}}},
    {"PutRequest": {"Item": {"email": {"S": "claudsrose1104@gmail.edu"}, "role": {"S": "user"}}}},
    {"PutRequest": {"Item": {"email": {"S": "antgrazioso@gmail.com"}, "role": {"S": "user"}}}},
    {"PutRequest": {"Item": {"email": {"S": "frank.mets@yahoo.com"}, "role": {"S": "user"}}}},
    {"PutRequest": {"Item": {"email": {"S": "livbrenn316@gmail.com"}, "role": {"S": "user"}}}},
    {"PutRequest": {"Item": {"email": {"S": "dfoti0401@gmail.com"}, "role": {"S": "user"}}}},
    {"PutRequest": {"Item": {"email": {"S": "joebrenn67@gmail.com"}, "role": {"S": "user"}}}},
    {"PutRequest": {"Item": {"email": {"S": "razzz1623@gmail.com"}, "role": {"S": "user"}}}}
  ]
}'

echo "Users seeded successfully."
