#!/bin/sh
# Substitute CSP-related env vars into the nginx config template and start nginx.
#
# Recognised variables (all optional; unset = empty string, which is harmless
# inside the CSP directive):
#
#   VITE_API_BASE_URL   – the public API origin, e.g. https://api.example.com
#   CSP_SENTRY_ORIGIN   – the Sentry ingest origin, e.g. https://o123.ingest.sentry.io
#   CSP_IMG_HOSTS       – space-separated extra img-src hosts,
#                         e.g. "https://cdn.example.com https://images.example.com"
#
# In development (docker-compose default) these can all be left unset; the
# proxy_pass block inside the template already forwards /api/* to the
# backend:3001 container, so 'self' is sufficient.

set -e

: "${VITE_API_BASE_URL:=}"
: "${CSP_SENTRY_ORIGIN:=}"
: "${CSP_IMG_HOSTS:=}"

envsubst '${VITE_API_BASE_URL} ${CSP_SENTRY_ORIGIN} ${CSP_IMG_HOSTS}' \
  < /etc/nginx/templates/nginx.conf.template \
  > /etc/nginx/conf.d/default.conf

exec nginx -g "daemon off;"
