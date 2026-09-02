"""Durable server-only Firestore storage for billing state."""

from __future__ import annotations

import hashlib
import uuid
from copy import deepcopy
from datetime import timedelta

from firebase_admin import firestore

from billing_observability import log_event
from billing_core import (
    BillingError,
    MAX_CLIENT_FAILURE_ATTEMPTS,
    Plan,
    _canonical_complimentary_validity,
    _complimentary_audit_id,
    _complimentary_operation_id,
    _complimentary_payload_hash,
    _complimentary_sha256,
    _domain_error,
    _required_utc_datetime,
    _validate_actor,
    _validate_uid,
    canonical_plan_snapshot,
    complimentary_grant_public,
    complimentary_grant_status,
    evaluate_coupon,
    normalize_email,
    normalize_grant_id,
    normalize_idempotency_key,
    normalize_plan_input,
    normalize_plan_selector,
    normalize_reason,
    normalize_validity,
    plan_from_record,
    public_coupon,
    resolve_effective_entitlement,
    subscription_public,
    utc_now,
    validate_complimentary_grant,
    validate_complimentary_pointer,
)


COLLECTIONS = {
    "plans": "billing_plans",
    "plan_catalog": "billing_plan_catalog",
    "coupons": "billing_coupons",
    "coupon_users": "billing_coupon_user_usage",
    "orders": "billing_orders",
    "provider_orders": "billing_provider_orders",
    "payments": "billing_payments",
    "payment_attempts": "billing_payment_attempts",
    "subscriptions": "billing_subscriptions",
    "redemptions": "billing_coupon_redemptions",
    "events": "billing_webhook_events",
    # These top-level collections are server/Admin-SDK persistence only. They
    # are deliberately separate from users/{uid} so account cleanup cannot
    # remove immutable billing history.
    "complimentary_grants": "billing_complimentary_grants",
    "complimentary_users": "billing_complimentary_users",
    "complimentary_operations": "billing_complimentary_operations",
    "complimentary_audit": "billing_complimentary_audit",
}

COMPLIMENTARY_COLLECTION_KEYS = frozenset({
    "complimentary_grants",
    "complimentary_users",
    "complimentary_operations",
    "complimentary_audit",
})

_OPERATION_FIELDS = frozenset({
    "actorUid", "operationType", "idempotencyKeyHash", "payloadHash", "status",
    "targetUid", "grantId", "responseSnapshot", "createdAt", "schemaVersion",
})
_GRANT_LIST_STATUSES = frozenset({"active", "expired", "revoked", "superseded"})
_LIST_SCAN_BATCH = 100
_LIST_MAX_INTERNAL_SCAN = 1000


def _data(snapshot):
    return ({"id": snapshot.id, **(snapshot.to_dict() or {})} if snapshot.exists else None)


def _raw_data(snapshot):
    """Return the stored document without injecting its Firestore document ID."""
    return deepcopy(snapshot.to_dict() or {}) if snapshot.exists else None


def _safe_doc_id(value):
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()


def _validate_target(target):
    if not isinstance(target, dict):
        raise _domain_error("The target account state is inconsistent")
    uid = _validate_uid(target.get("uid"))
    email = target.get("email")
    try:
        normalized_email = normalize_email(target.get("emailNormalized"))
        if normalize_email(email) != normalized_email:
            raise _domain_error("The target account state is inconsistent")
    except BillingError as error:
        if error.code == "billing_data_inconsistent":
            raise
        raise _domain_error("The target account state is inconsistent") from error
    if target.get("disabled") is True:
        raise BillingError("target_disabled", "The target account is disabled", 409)
    if target.get("emailVerified") is not True or target.get("grantEligible") is not True:
        raise BillingError(
            "target_email_unverified", "The target email is not verified", 409,
        )
    display_name = target.get("displayName")
    if display_name is not None and (
        not isinstance(display_name, str)
        or len(display_name.strip()) > 256
        or any(ord(character) < 32 or ord(character) == 127 for character in display_name)
    ):
        raise _domain_error("The target account state is inconsistent")
    return {
        "uid": uid,
        "email": email.strip(),
        "emailNormalized": normalized_email,
        "emailVerified": True,
        "displayName": display_name.strip() or None if isinstance(display_name, str) else None,
        "disabled": False,
        "grantEligible": True,
    }


def _validate_operation_replay(
    operation, actor_uid, operation_type, key_hash, payload_hash,
):
    if (
        not isinstance(operation, dict)
        or set(operation) != _OPERATION_FIELDS
        or operation.get("actorUid") != actor_uid
        or operation.get("operationType") != operation_type
        or operation.get("idempotencyKeyHash") != key_hash
        or operation.get("status") != "committed"
        or type(operation.get("schemaVersion")) is not int
        or operation.get("schemaVersion") < 1
        or not isinstance(operation.get("responseSnapshot"), dict)
    ):
        raise _domain_error()
    _validate_uid(operation.get("targetUid"))
    try:
        normalize_grant_id(operation.get("grantId"))
        _required_utc_datetime(operation.get("createdAt"), "createdAt", consistency=True)
    except BillingError as error:
        if error.code == "billing_data_inconsistent":
            raise
        raise _domain_error() from error
    if operation.get("payloadHash") != payload_hash:
        raise BillingError(
            "idempotency_conflict",
            "Idempotency key was already used with different operation details",
            409,
        )
    response = deepcopy(operation["responseSnapshot"])
    if set(response) != {
        "grant", "effectiveEntitlement", "paidFallback", "duplicate",
    } or response.get("duplicate") is not False:
        raise _domain_error()
    grant = response.get("grant")
    effective = response.get("effectiveEntitlement")
    fallback = response.get("paidFallback")
    if (
        not isinstance(grant, dict)
        or grant.get("id") != operation.get("grantId")
        or grant.get("source") != "complimentary"
        or not isinstance(effective, dict)
        or effective.get("source") not in (None, "paid", "complimentary")
        or (fallback is not None and (
            not isinstance(fallback, dict) or fallback.get("source") != "paid"
        ))
    ):
        raise _domain_error()
    response["duplicate"] = True
    return response


def _grant_from_snapshot(snapshot):
    value = _raw_data(snapshot)
    if value is None:
        return None
    grant = validate_complimentary_grant(value)
    if grant["id"] != snapshot.id:
        raise _domain_error()
    return grant


class FirestoreBillingStore:
    """Billing persistence whose state transitions are Firestore transactions."""

    def __init__(self, db):
        if db is None:
            raise ValueError("A Firestore client is required")
        self.db = db
        self.persisted_plans_required = False

    def _ref(self, key, document_id):
        return self.db.collection(COLLECTIONS[key]).document(str(document_id))

    def get_effective_entitlement(self, uid, now, require_valid_paid=True):
        """Load paid/pointer/grant state together and resolve it fail closed."""
        target_uid = _validate_uid(uid)
        evaluation_time = _required_utc_datetime(
            now, "evaluationTime", consistency=True,
        )
        subscription_ref = self._ref("subscriptions", target_uid)
        pointer_ref = self._ref("complimentary_users", target_uid)
        transaction = self.db.transaction()
        attempts = {"count": 0}

        @firestore.transactional
        def load(active_transaction):
            attempts["count"] += 1
            if attempts["count"] > 1:
                log_event(
                    operation="resolver_transaction",
                    result_code="retry",
                    duplicate=False,
                    target_uid=target_uid,
                    transition_type="transaction_retry",
                )
            paid = _raw_data(subscription_ref.get(transaction=active_transaction))
            pointer_value = _raw_data(pointer_ref.get(transaction=active_transaction))
            grant = None
            if pointer_value is not None:
                pointer = validate_complimentary_pointer(pointer_value, target_uid)
                if pointer["activeGrantId"] is not None:
                    grant_ref = self._ref(
                        "complimentary_grants", pointer["activeGrantId"],
                    )
                    grant_snapshot = grant_ref.get(transaction=active_transaction)
                    grant = _grant_from_snapshot(grant_snapshot)
                    if grant is None or grant["targetUid"] != target_uid:
                        raise _domain_error()
                    # A selected terminal record is corrupt. An expired record
                    # may remain selected because expiry is computed from time.
                    if grant["storedStatus"] != "active":
                        raise _domain_error()
            if require_valid_paid and paid is not None:
                subscription_public(paid, evaluation_time)
            return resolve_effective_entitlement(paid, grant, evaluation_time)

        return load(transaction)

    def create_complimentary_grant(
        self,
        *,
        actor,
        target,
        plan_id,
        validity,
        reason,
        idempotency_key,
        plan_loader,
        clock,
    ):
        """Atomically grant access, superseding only the selected active grant."""
        normalized_actor = _validate_actor(actor)
        normalized_target = _validate_target(target)
        normalized_plan_id = normalize_plan_selector(plan_id)
        normalized_validity = _canonical_complimentary_validity(validity)
        normalized_reason = normalize_reason(reason)
        normalized_key = normalize_idempotency_key(idempotency_key)
        operation_id = _complimentary_operation_id(
            normalized_actor["uid"], "grant", normalized_key,
        )
        key_hash = _complimentary_sha256(normalized_key)
        payload_hash = _complimentary_payload_hash({
            "targetUid": normalized_target["uid"],
            "targetEmail": normalized_target["emailNormalized"],
            "planId": normalized_plan_id,
            "validity": deepcopy(normalized_validity),
            "reason": normalized_reason,
        })
        # The Firestore plan document is authoritative inside the transaction;
        # this argument remains for parity with MemoryBillingStore's interface.
        _ = plan_loader
        grant_id = uuid.uuid4().hex
        operation_ref = self._ref("complimentary_operations", operation_id)
        plan_ref = self._ref("plans", normalized_plan_id)
        subscription_ref = self._ref("subscriptions", normalized_target["uid"])
        pointer_ref = self._ref("complimentary_users", normalized_target["uid"])
        grant_ref = self._ref("complimentary_grants", grant_id)
        transaction = self.db.transaction()
        attempts = {"count": 0}

        @firestore.transactional
        def create(active_transaction):
            attempts["count"] += 1
            if attempts["count"] > 1:
                log_event(
                    operation="grant_transaction",
                    result_code="retry",
                    duplicate=False,
                    actor_uid=normalized_actor["uid"],
                    target_uid=normalized_target["uid"],
                    grant_id=grant_id,
                    plan_id=normalized_plan_id,
                    validity_type=normalized_validity["type"],
                    transition_type="transaction_retry",
                )
            # Idempotency is always read first. A replay does no other reads and
            # performs no writes, preserving revisions and append-only audit.
            operation = _raw_data(
                operation_ref.get(transaction=active_transaction),
            )
            if operation is not None:
                return _validate_operation_replay(
                    operation,
                    normalized_actor["uid"],
                    "grant",
                    key_hash,
                    payload_hash,
                )

            attempt_time = _required_utc_datetime(clock(), "activationAt")
            plan_value = _raw_data(plan_ref.get(transaction=active_transaction))
            paid = _raw_data(
                subscription_ref.get(transaction=active_transaction),
            )
            pointer_value = _raw_data(
                pointer_ref.get(transaction=active_transaction),
            )

            if plan_value is None:
                raise BillingError(
                    "plan_not_found", "The selected billing plan was not found", 404,
                )
            if plan_value.get("id") != normalized_plan_id:
                raise _domain_error("The selected canonical plan is inconsistent")
            if plan_value.get("active") is not True:
                raise BillingError(
                    "plan_inactive", "The selected billing plan is inactive", 409,
                )
            plan_snapshot = canonical_plan_snapshot(plan_value)
            attempt_validity = normalize_validity(
                normalized_validity, attempt_time,
            )
            if paid is not None:
                subscription_public(paid, attempt_time)

            pointer_revision = 0
            prior_grant = None
            prior_ref = None
            if pointer_value is not None:
                pointer = validate_complimentary_pointer(
                    pointer_value, normalized_target["uid"],
                )
                pointer_revision = pointer["revision"]
                if pointer["activeGrantId"] is not None:
                    prior_ref = self._ref(
                        "complimentary_grants", pointer["activeGrantId"],
                    )
                    prior_snapshot = prior_ref.get(transaction=active_transaction)
                    prior_grant = _grant_from_snapshot(prior_snapshot)
                    if (
                        prior_grant is None
                        or prior_grant["targetUid"] != normalized_target["uid"]
                        or prior_grant["storedStatus"] != "active"
                    ):
                        raise _domain_error()

            grant = validate_complimentary_grant({
                "id": grant_id,
                "targetUid": normalized_target["uid"],
                "targetEmail": normalized_target["email"],
                "targetEmailNormalized": normalized_target["emailNormalized"],
                "targetDisplayName": normalized_target["displayName"],
                "planId": normalized_plan_id,
                "planSnapshot": plan_snapshot,
                "validityType": attempt_validity["validityType"],
                "presetDays": attempt_validity["presetDays"],
                "activationAt": attempt_time,
                "expiresAt": attempt_validity["expiresAt"],
                "lifetime": attempt_validity["lifetime"],
                "storedStatus": "active",
                "createdAt": attempt_time,
                "updatedAt": attempt_time,
                "createdBy": deepcopy(normalized_actor),
                "reason": normalized_reason,
                "endedAt": None,
                "endReason": None,
                "revokedBy": None,
                "supersededByGrantId": None,
                "supersededBy": None,
                "creationOperationId": operation_id,
                "schemaVersion": 1,
            })

            events = []
            prior_update = None
            if (
                prior_grant is not None
                and complimentary_grant_status(prior_grant, attempt_time) == "active"
            ):
                prior_update = deepcopy(prior_grant)
                prior_update.update({
                    "storedStatus": "superseded",
                    "updatedAt": attempt_time,
                    "endedAt": attempt_time,
                    "endReason": "Superseded by a newer complimentary grant",
                    "supersededByGrantId": grant_id,
                    "supersededBy": deepcopy(normalized_actor),
                })
                prior_update = validate_complimentary_grant(prior_update)
                superseded_event_id = _complimentary_audit_id(
                    operation_id, "superseded", prior_update["id"],
                )
                events.append((superseded_event_id, {
                    "eventId": superseded_event_id,
                    "eventType": "superseded",
                    "grantId": prior_update["id"],
                    "targetUid": normalized_target["uid"],
                    "actor": deepcopy(normalized_actor),
                    "replacementGrantId": grant_id,
                    "reason": "Superseded by a newer complimentary grant",
                    "occurredAt": attempt_time,
                    "operationId": operation_id,
                    "schemaVersion": 1,
                }))

            granted_event_id = _complimentary_audit_id(
                operation_id, "granted", grant_id,
            )
            events.append((granted_event_id, {
                "eventId": granted_event_id,
                "eventType": "granted",
                "grantId": grant_id,
                "targetUid": normalized_target["uid"],
                "actor": deepcopy(normalized_actor),
                "replacementGrantId": None,
                "reason": normalized_reason,
                "occurredAt": attempt_time,
                "operationId": operation_id,
                "schemaVersion": 1,
            }))
            pointer = validate_complimentary_pointer({
                "targetUid": normalized_target["uid"],
                "activeGrantId": grant_id,
                "revision": pointer_revision + 1,
                "updatedAt": attempt_time,
                "schemaVersion": 1,
            }, normalized_target["uid"])
            entitlement = resolve_effective_entitlement(paid, grant, attempt_time)
            response = {
                "grant": complimentary_grant_public(
                    grant, attempt_time, admin=True,
                ),
                **entitlement,
                "duplicate": False,
            }
            operation_record = {
                "actorUid": normalized_actor["uid"],
                "operationType": "grant",
                "idempotencyKeyHash": key_hash,
                "payloadHash": payload_hash,
                "status": "committed",
                "targetUid": normalized_target["uid"],
                "grantId": grant_id,
                "responseSnapshot": deepcopy(response),
                "createdAt": attempt_time,
                "schemaVersion": 1,
            }

            # Every read above completes before the first staged write below.
            if prior_update is not None:
                active_transaction.set(prior_ref, prior_update)
            active_transaction.create(grant_ref, grant)
            active_transaction.set(pointer_ref, pointer)
            for event_id, event in events:
                active_transaction.create(
                    self._ref("complimentary_audit", event_id), event,
                )
            active_transaction.create(operation_ref, operation_record)
            return deepcopy(response)

        return create(transaction)

    def revoke_complimentary_grant(
        self, *, actor, grant_id, reason, idempotency_key, clock,
    ):
        """Atomically revoke the currently selected effective grant."""
        normalized_actor = _validate_actor(actor)
        normalized_grant_id = normalize_grant_id(grant_id)
        normalized_reason = normalize_reason(reason)
        normalized_key = normalize_idempotency_key(idempotency_key)
        operation_id = _complimentary_operation_id(
            normalized_actor["uid"], "revoke", normalized_key,
        )
        key_hash = _complimentary_sha256(normalized_key)
        payload_hash = _complimentary_payload_hash({
            "grantId": normalized_grant_id, "reason": normalized_reason,
        })
        operation_ref = self._ref("complimentary_operations", operation_id)
        grant_ref = self._ref("complimentary_grants", normalized_grant_id)
        transaction = self.db.transaction()
        attempts = {"count": 0}

        @firestore.transactional
        def revoke(active_transaction):
            attempts["count"] += 1
            if attempts["count"] > 1:
                log_event(
                    operation="revoke_transaction",
                    result_code="retry",
                    duplicate=False,
                    actor_uid=normalized_actor["uid"],
                    grant_id=normalized_grant_id,
                    transition_type="transaction_retry",
                )
            operation = _raw_data(
                operation_ref.get(transaction=active_transaction),
            )
            if operation is not None:
                return _validate_operation_replay(
                    operation,
                    normalized_actor["uid"],
                    "revoke",
                    key_hash,
                    payload_hash,
                )

            attempt_time = _required_utc_datetime(clock(), "revokedAt")
            grant_snapshot = grant_ref.get(transaction=active_transaction)
            grant = _grant_from_snapshot(grant_snapshot)
            if grant is None:
                raise BillingError(
                    "grant_not_found", "Complimentary grant was not found", 404,
                )
            pointer_ref = self._ref("complimentary_users", grant["targetUid"])
            subscription_ref = self._ref("subscriptions", grant["targetUid"])
            pointer_value = _raw_data(
                pointer_ref.get(transaction=active_transaction),
            )
            paid = _raw_data(
                subscription_ref.get(transaction=active_transaction),
            )

            if pointer_value is None:
                raise BillingError(
                    "grant_state_conflict", "The grant is no longer active", 409,
                )
            pointer = validate_complimentary_pointer(
                pointer_value, grant["targetUid"],
            )
            if (
                pointer["activeGrantId"] != normalized_grant_id
                or complimentary_grant_status(grant, attempt_time) != "active"
            ):
                raise BillingError(
                    "grant_state_conflict", "The grant is no longer active", 409,
                )
            if paid is not None:
                subscription_public(paid, attempt_time)

            revoked = deepcopy(grant)
            revoked.update({
                "storedStatus": "revoked",
                "updatedAt": attempt_time,
                "endedAt": attempt_time,
                "endReason": normalized_reason,
                "revokedBy": deepcopy(normalized_actor),
            })
            revoked = validate_complimentary_grant(revoked)
            updated_pointer = validate_complimentary_pointer({
                "targetUid": grant["targetUid"],
                "activeGrantId": None,
                "revision": pointer["revision"] + 1,
                "updatedAt": attempt_time,
                "schemaVersion": 1,
            }, grant["targetUid"])
            entitlement = resolve_effective_entitlement(
                paid, revoked, attempt_time,
            )
            response = {
                "grant": complimentary_grant_public(
                    revoked, attempt_time, admin=True,
                ),
                **entitlement,
                "duplicate": False,
            }
            event_id = _complimentary_audit_id(
                operation_id, "revoked", normalized_grant_id,
            )
            event = {
                "eventId": event_id,
                "eventType": "revoked",
                "grantId": normalized_grant_id,
                "targetUid": grant["targetUid"],
                "actor": deepcopy(normalized_actor),
                "replacementGrantId": None,
                "reason": normalized_reason,
                "occurredAt": attempt_time,
                "operationId": operation_id,
                "schemaVersion": 1,
            }
            operation_record = {
                "actorUid": normalized_actor["uid"],
                "operationType": "revoke",
                "idempotencyKeyHash": key_hash,
                "payloadHash": payload_hash,
                "status": "committed",
                "targetUid": grant["targetUid"],
                "grantId": normalized_grant_id,
                "responseSnapshot": deepcopy(response),
                "createdAt": attempt_time,
                "schemaVersion": 1,
            }

            active_transaction.set(grant_ref, revoked)
            active_transaction.set(pointer_ref, updated_pointer)
            active_transaction.create(
                self._ref("complimentary_audit", event_id), event,
            )
            active_transaction.create(operation_ref, operation_record)
            return deepcopy(response)

        return revoke(transaction)

    def list_complimentary_grants(
        self, *, filters, limit, as_of, last_scanned=None,
    ):
        """Scan deterministically, computing status at one fixed UTC as-of."""
        evaluation_time = _required_utc_datetime(
            as_of, "asOf", consistency=True,
        )
        if type(limit) is not int or not 1 <= limit <= 100:
            raise BillingError(
                "invalid_limit", "limit must be an integer from 1 to 100",
                details={"field": "limit"},
            )
        if not isinstance(filters, dict) or set(filters) != {
            "email", "planId", "status",
        }:
            raise BillingError("invalid_filter", "Grant filters are invalid")
        email = (
            normalize_email(filters["email"])
            if filters["email"] not in (None, "") else None
        )
        selected_plan = (
            normalize_plan_selector(filters["planId"])
            if filters["planId"] not in (None, "") else None
        )
        selected_status = filters["status"]
        if selected_status not in (None, *_GRANT_LIST_STATUSES):
            raise BillingError(
                "invalid_filter", "status filter is invalid",
                details={"field": "status"},
            )

        query = self.db.collection(COLLECTIONS["complimentary_grants"])
        if email is not None:
            query = query.where("targetEmailNormalized", "==", email)
        if selected_plan is not None:
            query = query.where("planId", "==", selected_plan)
        query = query.order_by(
            "createdAt", direction=firestore.Query.DESCENDING,
        ).order_by("__name__", direction=firestore.Query.DESCENDING)

        marker_snapshot = None
        if last_scanned is not None:
            if not isinstance(last_scanned, dict) or set(last_scanned) != {
                "createdAt", "grantId",
            }:
                raise _domain_error()
            marker_time = _required_utc_datetime(
                last_scanned.get("createdAt"),
                "lastScanned.createdAt",
                consistency=True,
            )
            try:
                marker_id = normalize_grant_id(last_scanned.get("grantId"))
            except BillingError as error:
                raise _domain_error() from error
            marker_snapshot = self._ref(
                "complimentary_grants", marker_id,
            ).get()
            marker_grant = _grant_from_snapshot(marker_snapshot)
            if marker_grant is None or marker_grant["createdAt"] != marker_time:
                raise _domain_error()

        returned = []
        scanned = 0
        final_scanned = None
        has_more = False
        while scanned < _LIST_MAX_INTERNAL_SCAN:
            page_query = query
            if marker_snapshot is not None:
                page_query = page_query.start_after(marker_snapshot)
            remaining_budget = _LIST_MAX_INTERNAL_SCAN - scanned
            batch_size = min(_LIST_SCAN_BATCH, remaining_budget)
            raw_batch = list(page_query.limit(batch_size + 1).stream())
            batch = raw_batch[:batch_size]
            raw_more = len(raw_batch) > batch_size
            if not batch:
                break

            reached_limit = False
            for index, snapshot in enumerate(batch):
                grant = _grant_from_snapshot(snapshot)
                if grant is None:
                    raise _domain_error()
                scanned += 1
                final_scanned = {
                    "createdAt": grant["createdAt"], "grantId": grant["id"],
                }
                marker_snapshot = snapshot
                if (
                    selected_status is None
                    or complimentary_grant_status(grant, evaluation_time)
                    == selected_status
                ):
                    returned.append(grant)
                if len(returned) == limit:
                    has_more = index + 1 < len(batch) or raw_more
                    reached_limit = True
                    break
            if reached_limit:
                break
            if not raw_more:
                break
            if scanned >= _LIST_MAX_INTERNAL_SCAN:
                has_more = True
                break

        return {
            "grants": deepcopy(returned),
            "hasMore": has_more,
            "lastScanned": deepcopy(final_scanned) if has_more else None,
        }

    def require_persisted_plans(self):
        self.persisted_plans_required = True

    def seed_plans_if_empty(self, plans):
        records = [normalize_plan_input(value) for value in plans]
        sentinel_ref = self._ref("plan_catalog", "catalog")
        transaction = self.db.transaction()

        @firestore.transactional
        def seed(transaction):
            sentinel = _data(sentinel_ref.get(transaction=transaction))
            if sentinel:
                return False
            existing = list(self.db.collection(COLLECTIONS["plans"]).stream(transaction=transaction))
            now = utc_now()
            if not existing:
                for record in records:
                    value = deepcopy(record)
                    value.update({"revision": max(1, value.get("revision", 0)), "createdAt": now, "updatedAt": now})
                    transaction.set(self._ref("plans", value["id"]), value)
            transaction.set(sentinel_ref, {"initialized": True, "initializedAt": now, "updatedAt": now})
            return not existing

        return seed(transaction)

    def list_plans(self, include_inactive=False):
        values = [_data(snapshot) for snapshot in self.db.collection(COLLECTIONS["plans"]).stream()]
        values = [
            value for value in values
            if value and (include_inactive or value.get("active") is True)
        ]
        return sorted(values, key=lambda item: (item.get("sortOrder", 0), item["id"]))

    def get_plan(self, plan_id, include_inactive=False):
        value = _data(self._ref("plans", str(plan_id or "").strip().lower()).get())
        if not value or (not include_inactive and value.get("active") is not True):
            return None
        return value

    def put_plan(self, plan, create_only=False, expected_revision=None):
        record = normalize_plan_input(plan)
        ref = self._ref("plans", record["id"])
        transaction = self.db.transaction()

        @firestore.transactional
        def update(transaction):
            prior = _data(ref.get(transaction=transaction))
            if create_only and prior:
                raise BillingError("plan_exists", "A plan with this ID already exists", 409)
            if expected_revision is not None and (not prior or int(prior.get("revision", 0)) != expected_revision):
                raise BillingError("plan_conflict", "This plan changed while you were editing it. Reload and try again", 409)
            now = utc_now()
            value = deepcopy(record)
            value["revision"] = int((prior or {}).get("revision", 0)) + 1
            value["createdAt"] = (prior or {}).get("createdAt", now)
            value["updatedAt"] = now
            transaction.set(ref, value)
            return {"id": record["id"], **value}

        return update(transaction)

    def deactivate_plan(self, plan_id):
        ref = self._ref("plans", str(plan_id or "").strip().lower())
        transaction = self.db.transaction()

        @firestore.transactional
        def deactivate(transaction):
            prior = _data(ref.get(transaction=transaction))
            if not prior:
                raise BillingError("plan_not_found", "The selected billing plan was not found", 404)
            transaction.set(ref, {
                "active": False,
                "revision": int(prior.get("revision", 0)) + 1,
                "updatedAt": utc_now(),
            }, merge=True)
            prior["active"] = False
            prior["revision"] = int(prior.get("revision", 0)) + 1
            return prior

        return deactivate(transaction)

    def reorder_plans(self, plan_ids):
        transaction = self.db.transaction()

        @firestore.transactional
        def reorder(transaction):
            snapshots = list(self.db.collection(COLLECTIONS["plans"]).stream(transaction=transaction))
            values = [_data(snapshot) for snapshot in snapshots]
            all_ids = {value["id"] for value in values if value}
            if len(plan_ids) != len(set(plan_ids)) or set(plan_ids) != all_ids:
                raise BillingError("invalid_plan_order", "planIds must contain every plan exactly once")
            by_id = {value["id"]: value for value in values if value}
            now = utc_now()
            for index, plan_id in enumerate(plan_ids):
                transaction.set(self._ref("plans", plan_id), {
                    "sortOrder": index,
                    "revision": int(by_id[plan_id].get("revision", 0)) + 1,
                    "updatedAt": now,
                }, merge=True)
            return True

        reorder(transaction)
        return self.list_plans(include_inactive=True)

    def put_coupon(self, coupon, create_only=False):
        ref = self._ref("coupons", coupon["code"])
        transaction = self.db.transaction()

        @firestore.transactional
        def update(transaction):
            prior = _data(ref.get(transaction=transaction)) or {}
            if create_only and prior:
                raise BillingError("coupon_exists", "A coupon with this code already exists", 409)
            record = deepcopy(coupon)
            record["usedCount"] = int(prior.get("usedCount", coupon.get("usedCount", 0)))
            record["reservedCount"] = int(prior.get("reservedCount", coupon.get("reservedCount", 0)))
            record["updatedAt"] = utc_now()
            if not prior:
                record["createdAt"] = record["updatedAt"]
            else:
                record["createdAt"] = prior.get("createdAt", record["updatedAt"])
            transaction.set(ref, record)
            return record

        return update(transaction)

    def get_coupon(self, code):
        return _data(self._ref("coupons", code).get())

    def list_coupons(self):
        values = [_data(snapshot) for snapshot in self.db.collection(COLLECTIONS["coupons"]).stream()]
        return sorted((value for value in values if value), key=lambda value: value["code"])

    def _coupon_user_ref(self, uid, code):
        return self._ref("coupon_users", _safe_doc_id(uid + "\0" + code))

    def coupon_user_counts(self, uid, code):
        value = _data(self._coupon_user_ref(uid, code).get())
        return value or {"userId": uid, "couponCode": code, "usedCount": 0, "reservedCount": 0}

    def has_prior_payment(self, uid):
        query = self.db.collection(COLLECTIONS["payments"]).where("userId", "==", uid)
        return any(
            (snapshot.to_dict() or {}).get("status") == "captured"
            for snapshot in query.stream()
        )

    def cleanup_expired(self, now):
        # Coupon-backed provider orders keep their capacity reservation because
        # Razorpay Orders cannot be cancelled locally and may still capture.
        # Releasing those slots would allow late captures to exceed hard limits.
        # Other expired reservations are released transactionally.
        snapshots = []
        for snapshot in self.db.collection(COLLECTIONS["orders"]).stream():
            value = snapshot.to_dict() or {}
            if (
                value.get("status") == "reserved"
                and value.get("reservationExpiresAt")
                and value["reservationExpiresAt"] <= now
                and not (value.get("couponCode") and value.get("providerOrderId"))
            ):
                snapshots.append(snapshot)
        for snapshot in snapshots:
            try:
                self.release_internal_order(None, snapshot.id, now, "expired")
            except BillingError:
                continue

    def reserve_order(
        self, uid, idempotency_key, plan, coupon_code, now, expires_at,
        allow_zero=False, user_email=None,
    ):
        order_id = _safe_doc_id(uid + "\0" + idempotency_key)
        order_ref = self._ref("orders", order_id)
        coupon_ref = self._ref("coupons", coupon_code) if coupon_code else None
        usage_ref = self._coupon_user_ref(uid, coupon_code) if coupon_code else None
        subscription_ref = self._ref("subscriptions", uid)
        plan_ref = self._ref("plans", plan.id) if self.persisted_plans_required else None
        transaction = self.db.transaction()

        @firestore.transactional
        def reserve(transaction):
            existing = _data(order_ref.get(transaction=transaction))
            if existing:
                if existing.get("planId") != plan.id or existing.get("couponCode") != coupon_code:
                    raise BillingError("idempotency_conflict", "Idempotency key was already used for different checkout details", 409)
                return existing, False

            current_plan = plan
            if plan_ref is not None:
                stored_plan = _data(plan_ref.get(transaction=transaction))
                if not stored_plan or stored_plan.get("active") is not True:
                    raise BillingError("plan_not_found", "The selected billing plan is no longer available", 404)
                current_plan = plan_from_record(stored_plan)

            subscription = _data(subscription_ref.get(transaction=transaction))
            if (
                subscription
                and subscription.get("expiresAt")
                and subscription["expiresAt"] > now
                and subscription.get("planId") != current_plan.id
            ):
                raise BillingError(
                    "active_subscription_plan_conflict",
                    "An active subscription can only be extended with the same plan",
                    409,
                )

            discount = 0
            coupon_snapshot = None
            if coupon_code:
                coupon = _data(coupon_ref.get(transaction=transaction))
                usage = _data(usage_ref.get(transaction=transaction)) or {
                    "userId": uid, "couponCode": coupon_code, "usedCount": 0, "reservedCount": 0,
                }
                active_reservation = usage.get("activeReservationOrderId")
                active_until = usage.get("activeReservationExpiresAt")
                if active_reservation and active_reservation != order_id and active_until and active_until > now:
                    raise BillingError(
                        "coupon_reservation_exists",
                        "You already have an active checkout using this coupon",
                        409,
                    )
                has_prior = bool(subscription and int(subscription.get("paymentCount", 0)) > 0)
                discount = evaluate_coupon(
                    coupon, current_plan, now, int(usage.get("usedCount", 0)),
                    int(usage.get("reservedCount", 0)), has_prior,
                )
                coupon_snapshot = public_coupon(coupon)
                coupon_update = deepcopy(coupon)
                coupon_update.pop("id", None)
                coupon_update["reservedCount"] = int(coupon.get("reservedCount", 0)) + 1
                coupon_update["updatedAt"] = now
                usage["reservedCount"] = int(usage.get("reservedCount", 0)) + 1
                usage["activeReservationOrderId"] = order_id
                usage["activeReservationExpiresAt"] = expires_at
                usage["updatedAt"] = now
                usage.pop("id", None)
                transaction.set(coupon_ref, coupon_update)
                transaction.set(usage_ref, usage)

            final_amount = current_plan.amount_paise - discount
            if final_amount == 0 and not allow_zero:
                raise BillingError("zero_amount_not_allowed", "Coupons cannot reduce a Razorpay order to zero", 409)
            order = {
                "userId": uid,
                "userEmail": user_email,
                "idempotencyKeyHash": hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest(),
                "planId": current_plan.id,
                "planSnapshot": current_plan.snapshot(),
                "couponCode": coupon_code,
                "couponSnapshot": coupon_snapshot,
                "amountPaise": final_amount,
                "originalAmountPaise": current_plan.amount_paise,
                "discountPaise": discount,
                "currency": "INR",
                "status": "reserved" if final_amount > 0 else "zero_amount",
                "reservationExpiresAt": expires_at,
                "createdAt": now,
                "updatedAt": now,
                "providerOrderId": None,
            }
            transaction.set(order_ref, order)
            return {"id": order_id, **order}, True

        return reserve(transaction)

    def attach_provider_order(self, order_id, provider_order_id, now):
        order_ref = self._ref("orders", order_id)
        mapping_ref = self._ref("provider_orders", provider_order_id)
        transaction = self.db.transaction()

        @firestore.transactional
        def attach(transaction):
            order = _data(order_ref.get(transaction=transaction))
            if not order:
                raise BillingError("order_not_found", "Billing order was not found", 404)
            mapping = _data(mapping_ref.get(transaction=transaction))
            if mapping and mapping.get("billingOrderId") != order_id:
                raise BillingError("order_state_conflict", "Provider order is already linked", 409)
            if order.get("providerOrderId") and order["providerOrderId"] != provider_order_id:
                raise BillingError("order_state_conflict", "Checkout order is already linked", 409)
            transaction.set(order_ref, {"providerOrderId": provider_order_id, "updatedAt": now}, merge=True)
            transaction.set(mapping_ref, {
                "billingOrderId": order_id, "userId": order["userId"], "createdAt": now,
            })
            order["providerOrderId"] = provider_order_id
            order["updatedAt"] = now
            return order

        return attach(transaction)

    def _mapped_order_ref(self, provider_order_id):
        mapping = _data(self._ref("provider_orders", provider_order_id).get())
        return self._ref("orders", mapping["billingOrderId"]) if mapping else None

    def get_order_for_user(self, uid, provider_order_id):
        ref = self._mapped_order_ref(provider_order_id)
        order = _data(ref.get()) if ref else None
        return order if order and order.get("userId") == uid else None

    def get_order_by_provider(self, provider_order_id):
        ref = self._mapped_order_ref(provider_order_id)
        return _data(ref.get()) if ref else None

    def release_internal_order(self, uid, order_id, now, reason="failed"):
        order_ref = self._ref("orders", order_id)
        transaction = self.db.transaction()

        @firestore.transactional
        def release(transaction):
            order = _data(order_ref.get(transaction=transaction))
            if not order or (uid is not None and order.get("userId") != uid):
                raise BillingError("order_not_found", "Billing order was not found", 404)
            if order.get("status") != "reserved":
                return order
            code = order.get("couponCode")
            if code:
                coupon_ref = self._ref("coupons", code)
                usage_ref = self._coupon_user_ref(order["userId"], code)
                coupon = _data(coupon_ref.get(transaction=transaction))
                usage = _data(usage_ref.get(transaction=transaction))
                if coupon:
                    transaction.set(coupon_ref, {
                        "reservedCount": max(0, int(coupon.get("reservedCount", 0)) - 1), "updatedAt": now,
                    }, merge=True)
                if usage:
                    usage_update = {
                        "reservedCount": max(0, int(usage.get("reservedCount", 0)) - 1),
                        "updatedAt": now,
                    }
                    if usage.get("activeReservationOrderId") == order_id:
                        usage_update.update({
                            "activeReservationOrderId": None,
                            "activeReservationExpiresAt": None,
                        })
                    transaction.set(usage_ref, usage_update, merge=True)
            transaction.set(order_ref, {"status": reason, "updatedAt": now}, merge=True)
            order["status"] = reason
            order["updatedAt"] = now
            return order

        return release(transaction)

    def record_failed_attempt(self, uid, provider_order_id, now, payment_id=None):
        mapping = _data(self._ref("provider_orders", provider_order_id).get())
        if not mapping:
            raise BillingError("order_not_found", "Billing order was not found", 404)
        order_ref = self._ref("orders", mapping["billingOrderId"])
        current = _data(order_ref.get())
        if not current or (uid is not None and current.get("userId") != uid):
            raise BillingError("order_not_found", "Billing order was not found", 404)
        if (
            current.get("status") == "reserved"
            and current.get("reservationExpiresAt") <= now
            and not (current.get("couponCode") and current.get("providerOrderId"))
        ):
            return self.release_internal_order(uid, mapping["billingOrderId"], now, "expired")

        discriminator = payment_id or "client-reported-failure"
        attempt_id = _safe_doc_id(provider_order_id + "\0" + discriminator)
        attempt_ref = self._ref("payment_attempts", attempt_id)
        transaction = self.db.transaction()

        @firestore.transactional
        def record(transaction):
            order = _data(order_ref.get(transaction=transaction))
            existing_attempt = _data(attempt_ref.get(transaction=transaction))
            if not order or (uid is not None and order.get("userId") != uid):
                raise BillingError("order_not_found", "Billing order was not found", 404)
            if existing_attempt or order.get("status") != "reserved":
                return order
            if int(order.get("failureAttempts", 0)) >= MAX_CLIENT_FAILURE_ATTEMPTS:
                return order
            update = {
                "failureAttempts": int(order.get("failureAttempts", 0)) + 1,
                "lastFailedPaymentId": payment_id,
                "lastFailureAt": now,
                "updatedAt": now,
            }
            transaction.set(order_ref, update, merge=True)
            transaction.set(attempt_ref, {
                "userId": order["userId"], "userEmail": order.get("userEmail"),
                "provider": "razorpay", "providerOrderId": provider_order_id,
                "providerPaymentId": payment_id, "status": "failed",
                "planId": order["planId"], "planSnapshot": order["planSnapshot"],
                "couponCode": order.get("couponCode"),
                "couponSnapshot": order.get("couponSnapshot"),
                "originalAmountPaise": order["originalAmountPaise"],
                "discountPaise": order["discountPaise"],
                "amountPaise": order["amountPaise"], "currency": "INR",
                "createdAt": now, "verifiedAt": None,
            })
            order.update(update)
            return order

        return record(transaction)

    def release_order(self, uid, provider_order_id, now, reason="failed"):
        mapping = _data(self._ref("provider_orders", provider_order_id).get())
        if not mapping:
            raise BillingError("order_not_found", "Billing order was not found", 404)
        return self.release_internal_order(uid, mapping["billingOrderId"], now, reason)

    def activate_payment(self, order, provider_payment, now):
        evaluation_time = _required_utc_datetime(
            now, "evaluationTime", consistency=True,
        )
        order_ref = self._ref("orders", order["id"])
        payment_ref = self._ref("payments", provider_payment["id"])
        subscription_ref = self._ref("subscriptions", order["userId"])
        pointer_ref = self._ref("complimentary_users", order["userId"])
        transaction = self.db.transaction()
        attempts = {"count": 0}

        def load_paid_and_grant(active_transaction):
            paid = _raw_data(subscription_ref.get(transaction=active_transaction))
            pointer_value = _raw_data(pointer_ref.get(transaction=active_transaction))
            grant = None
            if pointer_value is not None:
                pointer = validate_complimentary_pointer(
                    pointer_value, order["userId"],
                )
                if pointer["activeGrantId"] is not None:
                    grant_snapshot = self._ref(
                        "complimentary_grants", pointer["activeGrantId"],
                    ).get(transaction=active_transaction)
                    grant = _grant_from_snapshot(grant_snapshot)
                    if (
                        grant is None
                        or grant["targetUid"] != order["userId"]
                        or grant["storedStatus"] != "active"
                    ):
                        raise _domain_error()
            return paid, grant

        @firestore.transactional
        def activate(active_transaction):
            attempts["count"] += 1
            if attempts["count"] > 1:
                plan_snapshot = order.get("planSnapshot") or {}
                log_event(
                    operation="payment_transaction",
                    result_code="retry",
                    duplicate=False,
                    target_uid=order.get("userId"),
                    plan_id=order.get("planId") or plan_snapshot.get("id"),
                    transition_type="transaction_retry",
                )
            existing = _data(payment_ref.get(transaction=active_transaction))
            if existing:
                if existing.get("providerOrderId") != order.get("providerOrderId"):
                    raise BillingError("payment_already_claimed", "This provider payment belongs to another order", 409)
                paid, grant = load_paid_and_grant(active_transaction)
                entitlement = resolve_effective_entitlement(
                    paid, grant, evaluation_time,
                )
                return existing, entitlement, False

            current = _data(order_ref.get(transaction=active_transaction))
            if not current or current.get("userId") != order.get("userId"):
                raise BillingError("order_not_found", "Billing order was not found", 404)
            if current.get("status") == "paid":
                raise BillingError("payment_state_conflict", "Paid order has no matching payment claim", 409)
            if current.get("status") not in ("reserved", "expired", "failed"):
                raise BillingError("payment_state_conflict", "Billing order cannot accept a captured payment", 409)
            late_capture = current.get("status") != "reserved" or current.get("reservationExpiresAt") <= evaluation_time

            code = current.get("couponCode")
            coupon_ref = None
            usage_ref = None
            redemption_ref = None
            coupon_update = None
            usage_update = None
            if code:
                coupon_ref = self._ref("coupons", code)
                usage_ref = self._coupon_user_ref(current["userId"], code)
                coupon = _data(coupon_ref.get(transaction=active_transaction))
                usage = _data(usage_ref.get(transaction=active_transaction)) or {"usedCount": 0, "reservedCount": 0}
                if not coupon:
                    raise BillingError("billing_data_inconsistent", "Coupon snapshot is unavailable", 503)
                coupon_update = {
                    "usedCount": int(coupon.get("usedCount", 0)) + 1,
                    "updatedAt": evaluation_time,
                }
                usage_update = {
                    "userId": current["userId"], "couponCode": code,
                    "usedCount": int(usage.get("usedCount", 0)) + 1,
                    "updatedAt": evaluation_time,
                }
                if current.get("status") == "reserved":
                    coupon_update["reservedCount"] = max(0, int(coupon.get("reservedCount", 0)) - 1)
                    usage_update["reservedCount"] = max(0, int(usage.get("reservedCount", 0)) - 1)
                if usage.get("activeReservationOrderId") == current["id"]:
                    usage_update.update({
                        "activeReservationOrderId": None,
                        "activeReservationExpiresAt": None,
                    })
                redemption_ref = self._ref("redemptions", current["id"])

            prior_subscription, grant = load_paid_and_grant(active_transaction)
            if prior_subscription is not None:
                subscription_public(prior_subscription, evaluation_time)
            changing_plan = bool(
                prior_subscription
                and prior_subscription.get("expiresAt")
                and prior_subscription["expiresAt"] > evaluation_time
                and prior_subscription.get("planId") != current["planId"]
            )
            starts = evaluation_time
            if (
                prior_subscription
                and prior_subscription.get("expiresAt")
                and prior_subscription["expiresAt"] > evaluation_time
                and not changing_plan
            ):
                starts = prior_subscription["expiresAt"]
            expires = starts + timedelta(days=int(current["planSnapshot"]["durationDays"]))
            payment = {
                "userId": current["userId"], "userEmail": current.get("userEmail"),
                "provider": "razorpay",
                "providerPaymentId": provider_payment["id"], "providerOrderId": current["providerOrderId"],
                "status": "captured", "amountPaise": current["amountPaise"],
                "originalAmountPaise": current["originalAmountPaise"], "discountPaise": current["discountPaise"],
                "currency": "INR", "method": provider_payment.get("method"),
                "bank": provider_payment.get("bank"), "wallet": provider_payment.get("wallet"),
                "vpa": provider_payment.get("vpa"), "feePaise": provider_payment.get("fee"),
                "taxPaise": provider_payment.get("tax"), "providerCreatedAt": provider_payment.get("created_at"),
                "planId": current["planId"], "planSnapshot": current["planSnapshot"],
                "couponCode": code, "couponSnapshot": current.get("couponSnapshot"),
                "lateCapture": late_capture,
                "planChangeImmediate": changing_plan,
                "createdAt": evaluation_time, "verifiedAt": evaluation_time,
                "subscriptionStartsAt": starts, "subscriptionExpiresAt": expires,
            }
            subscription = {
                "userId": current["userId"], "status": "active", "planId": current["planId"],
                "entitlementTier": current["planSnapshot"].get("entitlementTier", current["planId"]),
                "startsAt": starts, "expiresAt": expires, "updatedAt": evaluation_time,
                "lastPaymentId": provider_payment["id"],
                "paymentCount": int((prior_subscription or {}).get("paymentCount", 0)) + 1,
            }

            if code:
                active_transaction.set(coupon_ref, coupon_update, merge=True)
                active_transaction.set(usage_ref, usage_update, merge=True)
                active_transaction.set(redemption_ref, {
                    "userId": current["userId"], "couponCode": code,
                    "providerPaymentId": provider_payment["id"],
                    "providerOrderId": current["providerOrderId"],
                    "discountPaise": current["discountPaise"],
                    "lateCapture": late_capture, "createdAt": evaluation_time,
                })
            active_transaction.set(payment_ref, payment)
            active_transaction.set(subscription_ref, subscription)
            active_transaction.set(order_ref, {
                "status": "paid", "providerPaymentId": provider_payment["id"], "updatedAt": evaluation_time,
            }, merge=True)
            entitlement = resolve_effective_entitlement(
                subscription, grant, evaluation_time,
            )
            return {"id": provider_payment["id"], **payment}, entitlement, True

        return activate(transaction)

    def list_payments(self, uid, limit=100):
        maximum = max(1, min(int(limit), 200))
        values = [
            _data(snapshot)
            for snapshot in self.db.collection(COLLECTIONS["payments"]).stream()
            if (snapshot.to_dict() or {}).get("userId") == uid
        ]
        values.extend(
            _data(snapshot)
            for snapshot in self.db.collection(COLLECTIONS["payment_attempts"]).stream()
            if (snapshot.to_dict() or {}).get("userId") == uid
        )
        return sorted(values, key=lambda value: value.get("createdAt"), reverse=True)[:maximum]

    def get_payment_by_order(self, uid, provider_order_id):
        for snapshot in self.db.collection(COLLECTIONS["payments"]).stream():
            value = _data(snapshot)
            if value.get("userId") == uid and value.get("providerOrderId") == provider_order_id:
                return value
        return None

    def get_subscription(self, uid):
        return _data(self._ref("subscriptions", uid).get())

    def claim_event(self, event_id, payload_hash, now):
        ref = self._ref("events", event_id)
        transaction = self.db.transaction()

        @firestore.transactional
        def claim(transaction):
            existing = _data(ref.get(transaction=transaction))
            if existing and existing.get("payloadHash") != payload_hash:
                raise BillingError("webhook_event_conflict", "Webhook event ID was reused with different content", 409)
            if existing and existing.get("status") == "completed":
                return False
            if (
                existing and existing.get("status") == "processing"
                and existing.get("leaseExpiresAt") and existing["leaseExpiresAt"] > now
            ):
                raise BillingError("webhook_event_processing", "Webhook event is already being processed", 503)
            transaction.set(ref, {
                "payloadHash": payload_hash, "status": "processing",
                "attempts": int((existing or {}).get("attempts", 0)) + 1,
                "leaseExpiresAt": now + timedelta(minutes=5),
                "createdAt": (existing or {}).get("createdAt", now), "updatedAt": now,
            })
            return True

        return claim(transaction)

    def finish_event(self, event_id, status, now, outcome=None):
        self._ref("events", event_id).set({"status": status, "outcome": outcome, "updatedAt": now}, merge=True)

    def list_redemptions(self, limit=200):
        query = self.db.collection(COLLECTIONS["redemptions"]).order_by("createdAt", direction=firestore.Query.DESCENDING).limit(max(1, min(int(limit), 500)))
        return [_data(snapshot) for snapshot in query.stream()]

    def analytics(self):
        payments = [_data(snapshot) for snapshot in self.db.collection(COLLECTIONS["payments"]).stream()]
        subscriptions = [_data(snapshot) for snapshot in self.db.collection(COLLECTIONS["subscriptions"]).stream()]
        redemptions = [_data(snapshot) for snapshot in self.db.collection(COLLECTIONS["redemptions"]).stream()]
        coupons = [_data(snapshot) for snapshot in self.db.collection(COLLECTIONS["coupons"]).stream()]
        now = utc_now()
        discounts = sum(int(value.get("discountPaise", 0)) for value in payments)
        return {
            "totalCoupons": len(coupons),
            "activeCoupons": sum(
                1 for value in coupons
                if value.get("active")
                and (not value.get("startsAt") or value["startsAt"] <= now)
                and (not value.get("expiresAt") or value["expiresAt"] > now)
            ),
            "expiredCoupons": sum(
                1 for value in coupons
                if value.get("expiresAt") and value["expiresAt"] <= now
            ),
            "totalCouponUses": sum(int(value.get("usedCount", 0)) for value in coupons),
            "totalDiscountGivenPaise": discounts,
            "capturedPayments": len(payments),
            "grossRevenuePaise": sum(int(value.get("amountPaise", 0)) for value in payments),
            "discountsPaise": discounts,
            "activeSubscriptions": sum(1 for value in subscriptions if value.get("expiresAt") and value["expiresAt"] > now),
            "couponRedemptions": len(redemptions),
        }
