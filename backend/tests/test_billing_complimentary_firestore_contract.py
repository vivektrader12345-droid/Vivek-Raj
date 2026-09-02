"""Regression-first Firestore contract for complimentary billing.

Task 6 deliberately describes the Firestore behavior before Task 7 implements
it.  The in-memory examples are executable contract baselines.  Firestore
examples use a recording transaction fake so missing behavior fails at the
smallest store boundary and later implementations can prove read/write order,
retry-time rereads, and atomicity without an emulator.
"""

from __future__ import annotations

import hashlib
import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from functools import wraps
from unittest.mock import patch

import billing_core as core
import billing_store as store_module


UTC = timezone.utc
NOW = datetime(2025, 3, 4, 10, 15, tzinfo=UTC)
ACTOR = {"uid": "admin-uid", "email": "admin@example.com"}
TARGET = {
    "uid": "target-uid",
    "email": "person@example.com",
    "emailNormalized": "person@example.com",
    "emailVerified": True,
    "displayName": "Person",
    "disabled": False,
    "grantEligible": True,
}
PLAN = {
    "id": "pro",
    "name": "Pro",
    "amountPaise": 99900,
    "durationDays": 30,
    "features": ["Advanced analytics", "Priority support"],
    "active": True,
    "sortOrder": 1,
    "entitlementTier": "pro",
    "revision": 7,
    "createdAt": NOW - timedelta(days=30),
    "updatedAt": NOW - timedelta(days=1),
}
PAID = {
    "userId": TARGET["uid"],
    "status": "active",
    "planId": "basic",
    "entitlementTier": "basic",
    "startsAt": NOW - timedelta(days=2),
    "expiresAt": NOW + timedelta(days=20),
    "updatedAt": NOW - timedelta(days=1),
    "lastPaymentId": "pay-preserved",
    "paymentCount": 2,
}
GRANT_COLLECTION = "billing_complimentary_grants"
POINTER_COLLECTION = "billing_complimentary_users"
OPERATION_COLLECTION = "billing_complimentary_operations"
AUDIT_COLLECTION = "billing_complimentary_audit"
PLAN_COLLECTION = "billing_plans"
SUBSCRIPTION_COLLECTION = "billing_subscriptions"
CURSOR_KEY = b"task-6-firestore-contract-cursor-key"


def sha256(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def operation_id(operation_type, key):
    return sha256(ACTOR["uid"] + "\0" + operation_type + "\0" + key)


def audit_id(operation, event_type, grant_id):
    return sha256(operation + "\0" + event_type + "\0" + grant_id)


class MutableClock:
    def __init__(self, value=NOW):
        self.value = value
        self.calls = []

    def __call__(self):
        self.calls.append(self.value)
        return self.value

    def advance(self, **delta):
        self.value += timedelta(**delta)


class SequenceClock:
    def __init__(self, *values):
        self.values = list(values)
        self.calls = []

    def __call__(self):
        index = min(len(self.calls), len(self.values) - 1)
        value = self.values[index]
        self.calls.append(value)
        return value


class SyntheticAbort(Exception):
    pass


class FakeSnapshot:
    def __init__(self, reference, value):
        self.reference = reference
        self.id = reference.id
        self.exists = value is not None
        self._value = deepcopy(value)

    def to_dict(self):
        return deepcopy(self._value or {})


class RecordingTransaction:
    def __init__(self, database):
        self.database = database
        self.attempt = 0
        self.pending = []
        self.write_count = 0

    def begin_attempt(self):
        self.attempt += 1
        self.pending = []
        self.write_count = 0

    def discard(self):
        self.pending = []

    def get(self, reference):
        if isinstance(reference, FakeQuery):
            return list(reference.stream(transaction=self))
        self.database.events.append(("read", self.attempt, reference.path))
        return FakeSnapshot(reference, self.database.store.get(reference.path))

    def _stage(self, operation, reference, value=None, merge=False):
        self.write_count += 1
        self.database.events.append(("write", self.attempt, reference.path))
        if self.database.fail_on_write == self.write_count:
            raise RuntimeError("synthetic transaction write failure")
        self.pending.append((operation, reference.path, deepcopy(value), merge))

    def set(self, reference, value, merge=False):
        self._stage("set", reference, value, merge)

    def create(self, reference, value):
        if reference.path in self.database.store:
            raise RuntimeError("document already exists")
        self._stage("set", reference, value, False)

    def update(self, reference, value):
        self._stage("set", reference, value, True)

    def delete(self, reference):
        self._stage("delete", reference)

    def commit(self):
        if self.database.abort_commits:
            self.database.abort_commits -= 1
            self.discard()
            if self.database.on_abort is not None:
                self.database.on_abort(self.database, self.attempt)
            raise SyntheticAbort("synthetic contention")
        if self.database.fail_commit:
            self.discard()
            raise RuntimeError("synthetic commit failure")
        for operation, path, value, merge in self.pending:
            if operation == "delete":
                self.database.store.pop(path, None)
            elif merge:
                current = deepcopy(self.database.store.get(path) or {})
                current.update(value)
                self.database.store[path] = current
            else:
                self.database.store[path] = deepcopy(value)
        self.database.commits += 1
        self.pending = []


class FakeDocument:
    def __init__(self, database, path):
        self.database = database
        self.path = path
        self.id = path[-1]

    def get(self, transaction=None):
        if transaction is not None:
            return transaction.get(self)
        self.database.events.append(("direct-read", 0, self.path))
        return FakeSnapshot(self, self.database.store.get(self.path))

    def set(self, value, merge=False):
        current = deepcopy(self.database.store.get(self.path) or {}) if merge else {}
        current.update(deepcopy(value))
        self.database.store[self.path] = current

    def delete(self):
        self.database.store.pop(self.path, None)

    def collection(self, name):
        return FakeCollection(self.database, self.path + (name,))


class FakeQuery:
    def __init__(self, database, path, filters=None, orders=None, maximum=None, start=None):
        self.database = database
        self.path = path
        self.filters = list(filters or [])
        self.orders = list(orders or [])
        self.maximum = maximum
        self.start = deepcopy(start)

    def _clone(self, **changes):
        values = {
            "filters": self.filters,
            "orders": self.orders,
            "maximum": self.maximum,
            "start": self.start,
        }
        values.update(changes)
        return self.__class__(self.database, self.path, **values)

    def where(self, *args, **kwargs):
        if "filter" in kwargs:
            field_filter = kwargs["filter"]
            condition = (
                getattr(field_filter, "field_path", None),
                getattr(field_filter, "op_string", None),
                getattr(field_filter, "value", None),
            )
        else:
            condition = tuple(args[:3])
        return self._clone(filters=self.filters + [condition])

    def order_by(self, field, direction=None):
        return self._clone(orders=self.orders + [(field, direction)])

    def limit(self, value):
        return self._clone(maximum=int(value))

    def start_after(self, value):
        return self._clone(start=value)

    def _matches(self, snapshot):
        value = snapshot.to_dict()
        for field, operator, expected in self.filters:
            if operator != "==" or value.get(field) != expected:
                return False
        return True

    @staticmethod
    def _direction_desc(direction):
        return "DESC" in str(direction).upper()

    def _ordered(self, snapshots):
        ordered = list(snapshots)
        for field, direction in reversed(self.orders):
            if field in ("__name__", "__name__"):
                key = lambda item: item.id
            else:
                key = lambda item, selected=field: item.to_dict().get(selected)
            ordered.sort(key=key, reverse=self._direction_desc(direction))
        return ordered

    def _after_start(self, snapshots):
        if self.start is None or not self.orders:
            return snapshots
        if isinstance(self.start, FakeSnapshot):
            marker = self.start
        elif isinstance(self.start, dict):
            marker_id = self.start.get("__name__") or self.start.get("grantId")
            marker_ref = FakeDocument(self.database, self.path + (str(marker_id),))
            marker = FakeSnapshot(marker_ref, self.start)
        else:
            return snapshots
        keys = []
        for field, _direction in self.orders:
            keys.append(marker.id if field == "__name__" else marker.to_dict().get(field))
        for index, snapshot in enumerate(snapshots):
            candidate = [
                snapshot.id if field == "__name__" else snapshot.to_dict().get(field)
                for field, _direction in self.orders
            ]
            if candidate == keys:
                return snapshots[index + 1:]
        return snapshots

    def stream(self, transaction=None):
        if transaction is not None:
            self.database.events.append(("query-read", transaction.attempt, self.path))
        else:
            self.database.events.append(("direct-query-read", 0, self.path))
        expected_length = len(self.path) + 1
        snapshots = [
            FakeSnapshot(FakeDocument(self.database, path), value)
            for path, value in self.database.store.items()
            if path[:len(self.path)] == self.path and len(path) == expected_length
        ]
        snapshots = self._ordered(snapshot for snapshot in snapshots if self._matches(snapshot))
        snapshots = self._after_start(snapshots)
        if self.maximum is not None:
            snapshots = snapshots[:self.maximum]
        return iter(snapshots)

    def get(self, transaction=None):
        return list(self.stream(transaction=transaction))


class FakeCollection(FakeQuery):
    def document(self, document_id=None):
        if document_id is None:
            document_id = "auto-%032d" % self.database.next_auto_id
            self.database.next_auto_id += 1
        return FakeDocument(self.database, self.path + (str(document_id),))


class RecordingFirestore:
    def __init__(self):
        self.store = {}
        self.events = []
        self.transactions = []
        self.commits = 0
        self.abort_commits = 0
        self.on_abort = None
        self.fail_commit = False
        self.fail_on_write = None
        self.next_auto_id = 1

    def collection(self, name):
        return FakeCollection(self, (name,))

    def transaction(self):
        transaction = RecordingTransaction(self)
        self.transactions.append(transaction)
        return transaction

    def seed(self, collection, document_id, value):
        self.store[(collection, document_id)] = deepcopy(value)

    def documents(self, collection):
        return {
            path[-1]: deepcopy(value)
            for path, value in self.store.items()
            if len(path) == 2 and path[0] == collection
        }


def recording_transactional(callback):
    """Minimal retrying replacement for firebase_admin.firestore.transactional."""

    @wraps(callback)
    def invoke(transaction, *args, **kwargs):
        while True:
            transaction.begin_attempt()
            try:
                result = callback(transaction, *args, **kwargs)
            except Exception:
                transaction.discard()
                raise
            try:
                transaction.commit()
            except SyntheticAbort:
                continue
            return result

    return invoke


def assert_reads_before_writes(test, database, attempt):
    operations = [
        kind for kind, event_attempt, _path in database.events
        if event_attempt == attempt and kind in ("read", "query-read", "write")
    ]
    test.assertIn("write", operations, "the transaction did not stage a write")
    first_write = operations.index("write")
    test.assertNotIn(
        "read", operations[first_write + 1:],
        "Firestore transactions must finish document reads before staging writes",
    )
    test.assertNotIn(
        "query-read", operations[first_write + 1:],
        "Firestore transactions must finish query reads before staging writes",
    )


def transaction_read_paths(database, attempt=None):
    return [
        path for kind, event_attempt, path in database.events
        if kind in ("read", "query-read") and (attempt is None or event_attempt == attempt)
    ]


def normalize_observable(value):
    """Remove opaque IDs while preserving their relationships in public results."""
    if isinstance(value, dict):
        return {
            key: normalize_observable(item)
            for key, item in value.items()
            if key not in {"id", "grantId", "supersededByGrantId"}
        }
    if isinstance(value, list):
        return [normalize_observable(item) for item in value]
    return value


class StoreScenario:
    def __init__(self, store, clock, database=None):
        self.store = store
        self.clock = clock
        self.database = database

    @classmethod
    def memory(cls):
        store = core.MemoryBillingStore()
        store.plans[PLAN["id"]] = deepcopy(PLAN)
        store.subscriptions[TARGET["uid"]] = deepcopy(PAID)
        return cls(store, MutableClock())

    @classmethod
    def firestore(cls):
        database = RecordingFirestore()
        database.seed(PLAN_COLLECTION, PLAN["id"], PLAN)
        database.seed(SUBSCRIPTION_COLLECTION, TARGET["uid"], PAID)
        store = store_module.FirestoreBillingStore(database)
        return cls(store, MutableClock(), database)

    def require(self, method_name):
        method = getattr(self.store, method_name, None)
        if method is None:
            raise AssertionError(
                "Task 7 missing FirestoreBillingStore.%s" % method_name
            )
        return method

    def plan_loader(self, plan_id):
        return self.store.get_plan(plan_id, include_inactive=True)

    def create(self, *, target=None, key="grant-contract-key-001", validity=None, reason="Support grant"):
        return self.require("create_complimentary_grant")(
            actor=deepcopy(ACTOR),
            target=deepcopy(target or TARGET),
            plan_id=PLAN["id"],
            validity=deepcopy(validity or {"type": "lifetime"}),
            reason=reason,
            idempotency_key=key,
            plan_loader=self.plan_loader,
            clock=self.clock,
        )

    def revoke(self, grant_id, *, key="revoke-contract-key-01"):
        return self.require("revoke_complimentary_grant")(
            actor=deepcopy(ACTOR),
            grant_id=grant_id,
            reason="Access ended",
            idempotency_key=key,
            clock=self.clock,
        )

    def resolve(self, now=None):
        return self.require("get_effective_entitlement")(
            TARGET["uid"], now or self.clock.value, require_valid_paid=True,
        )

    def list(self, *, filters=None, limit=25, as_of=None, last_scanned=None):
        return self.require("list_complimentary_grants")(
            filters=filters or {"email": None, "planId": None, "status": None},
            limit=limit,
            as_of=as_of or self.clock.value,
            last_scanned=last_scanned,
        )

    def documents(self, name):
        if self.database is not None:
            return self.database.documents(name)
        mapping = {
            GRANT_COLLECTION: self.store.complimentary_grants,
            POINTER_COLLECTION: self.store.complimentary_users,
            OPERATION_COLLECTION: self.store.complimentary_operations,
            AUDIT_COLLECTION: self.store.complimentary_audit,
        }
        return deepcopy(mapping[name])

    def complimentary_snapshot(self):
        return deepcopy({
            name: self.documents(name)
            for name in (
                GRANT_COLLECTION,
                POINTER_COLLECTION,
                OPERATION_COLLECTION,
                AUDIT_COLLECTION,
            )
        })


def lifecycle_summary(scenario):
    created = scenario.create()
    grant_id = created["grant"]["id"]
    resolved = scenario.resolve()
    listed = scenario.list()
    scenario.clock.advance(seconds=1)
    revoked = scenario.revoke(grant_id)
    after_revoke = scenario.resolve()
    return normalize_observable({
        "created": created,
        "resolved": resolved,
        "listed": listed,
        "revoked": revoked,
        "afterRevoke": after_revoke,
    })


class MemoryStoreContractTests(unittest.TestCase):
    """Passing oracle for the behavior Firestore must expose after Task 7."""

    # **Validates: Requirements 5.1, 8.2, 9.2-9.4, 10.1-10.4, 12.1-12.4**
    def test_memory_create_resolver_list_and_revoke_observable_contract_passes(self):
        summary = lifecycle_summary(StoreScenario.memory())
        self.assertEqual(summary["created"]["effectiveEntitlement"]["source"], "complimentary")
        self.assertEqual(summary["created"]["paidFallback"]["source"], "paid")
        self.assertEqual(summary["resolved"], {
            "effectiveEntitlement": summary["created"]["effectiveEntitlement"],
            "paidFallback": summary["created"]["paidFallback"],
        })
        self.assertEqual(len(summary["listed"]["grants"]), 1)
        self.assertEqual(summary["listed"]["grants"][0]["storedStatus"], "active")
        self.assertEqual(summary["revoked"]["grant"]["status"], "revoked")
        self.assertEqual(summary["afterRevoke"]["effectiveEntitlement"]["source"], "paid")

    # **Validates: Requirements 5.4, 8.2, 16.1-16.2, 16.5-16.7**
    def test_memory_revisions_deterministic_audits_and_response_snapshots_pass(self):
        scenario = StoreScenario.memory()
        first_key = "grant-replay-key-001"
        first = scenario.create(key=first_key)
        first_id = first["grant"]["id"]
        state = scenario.complimentary_snapshot()
        replay = scenario.create(key=first_key)
        self.assertTrue(replay["duplicate"])
        self.assertEqual({**replay, "duplicate": False}, first)
        self.assertEqual(scenario.complimentary_snapshot(), state)

        first_operation = operation_id("grant", first_key)
        operation = scenario.documents(OPERATION_COLLECTION)[first_operation]
        self.assertEqual(operation["responseSnapshot"], first)
        self.assertEqual(
            scenario.documents(AUDIT_COLLECTION)[audit_id(first_operation, "granted", first_id)]["eventType"],
            "granted",
        )

        scenario.clock.advance(seconds=1)
        second = scenario.create(key="grant-second-key-001")
        scenario.clock.advance(seconds=1)
        scenario.revoke(second["grant"]["id"])
        pointer = scenario.documents(POINTER_COLLECTION)[TARGET["uid"]]
        self.assertEqual(pointer["revision"], 3)
        self.assertIsNone(pointer["activeGrantId"])
        self.assertEqual(
            [event["eventType"] for event in scenario.documents(AUDIT_COLLECTION).values()].count("superseded"),
            1,
        )

    # **Validates: Requirements 7.1-7.5, 12.4**
    def test_memory_fixed_asof_status_scan_and_equal_timestamp_tie_break_pass(self):
        scenario = StoreScenario.memory()
        targets = []
        for uid, email in (("old-a", "a@example.com"), ("old-b", "b@example.com")):
            target = {**TARGET, "uid": uid, "email": email, "emailNormalized": email}
            targets.append(scenario.create(target=target, key="grant-%s-key-001" % uid))
        tied_ids = sorted([item["grant"]["id"] for item in targets], reverse=True)

        scenario.clock.advance(seconds=1)
        expiring_target = {
            **TARGET,
            "uid": "expiring",
            "email": "expiring@example.com",
            "emailNormalized": "expiring@example.com",
        }
        expired = scenario.create(
            target=expiring_target,
            key="grant-expiring-key-01",
            validity={"type": "preset", "days": 7},
        )
        scenario.clock.advance(seconds=1)
        newest_target = {
            **TARGET,
            "uid": "newest",
            "email": "newest@example.com",
            "emailNormalized": "newest@example.com",
        }
        newest = scenario.create(target=newest_target, key="grant-newest-key-001")
        as_of = NOW + timedelta(days=8)

        unfiltered = scenario.list(as_of=as_of)
        self.assertEqual(
            [grant["id"] for grant in unfiltered["grants"]],
            [newest["grant"]["id"], expired["grant"]["id"], *tied_ids],
        )

        filters = {"email": None, "planId": None, "status": "active"}
        first_page = scenario.list(filters=filters, limit=2, as_of=as_of)
        self.assertEqual(
            [grant["id"] for grant in first_page["grants"]],
            [newest["grant"]["id"], tied_ids[0]],
        )
        self.assertTrue(first_page["hasMore"])
        self.assertEqual(first_page["lastScanned"]["grantId"], tied_ids[0])
        second_page = scenario.list(
            filters=filters,
            limit=2,
            as_of=as_of,
            last_scanned=first_page["lastScanned"],
        )
        self.assertEqual([grant["id"] for grant in second_page["grants"]], [tied_ids[1]])
        self.assertFalse(second_page["hasMore"])

    # **Validates: Requirements 5.5, 9.5, 14.4**
    def test_memory_failure_before_commit_leaves_no_partial_writes(self):
        scenario = StoreScenario.memory()
        before = scenario.complimentary_snapshot()

        def unavailable_plan(_plan_id):
            raise RuntimeError("synthetic plan read failure")

        with self.assertRaises(RuntimeError):
            scenario.store.create_complimentary_grant(
                actor=deepcopy(ACTOR),
                target=deepcopy(TARGET),
                plan_id=PLAN["id"],
                validity={"type": "lifetime"},
                reason=None,
                idempotency_key="atomic-memory-key-001",
                plan_loader=unavailable_plan,
                clock=scenario.clock,
            )
        self.assertEqual(scenario.complimentary_snapshot(), before)


class FirestoreStoreContractTests(unittest.TestCase):
    def setUp(self):
        self.transactional = patch.object(
            store_module.firestore, "transactional", recording_transactional,
        )
        self.transactional.start()
        self.addCleanup(self.transactional.stop)

    # **Validates: Requirements 5.1, 7.1-7.5, 8.2, 9.2-9.5, 10.1-10.7, 12.1-12.4**
    def test_firestore_matches_memory_observable_create_resolver_list_and_revoke_contract(self):
        expected = lifecycle_summary(StoreScenario.memory())
        actual = lifecycle_summary(StoreScenario.firestore())
        self.assertEqual(actual, expected)

    # **Validates: Requirements 7.1-7.5, 12.4, 14.3**
    def test_signed_cursor_tamper_and_filter_changes_fail_before_firestore_reads(self):
        filters = {"email": None, "planId": "pro", "status": "active"}
        cursor = core.encode_grant_list_cursor(
            filters, NOW, NOW, "grant-cursor-id-001", CURSOR_KEY, key_id="test-v1",
        )
        tampered = cursor[:-1] + ("A" if cursor[-1] != "A" else "B")
        for candidate, expected_filters in (
            (tampered, filters),
            (cursor, {**filters, "planId": "basic"}),
            (cursor, {**filters, "status": "expired"}),
        ):
            with self.subTest(candidate=candidate[-8:], filters=expected_filters):
                with self.assertRaises(core.BillingError) as raised:
                    core.decode_grant_list_cursor(
                        candidate, {"test-v1": CURSOR_KEY}, expected_filters,
                    )
                self.assertEqual(raised.exception.code, "invalid_cursor")


class FirestoreTransactionRegressionTests(unittest.TestCase):
    def setUp(self):
        self.transactional = patch.object(
            store_module.firestore, "transactional", recording_transactional,
        )
        self.transactional.start()
        self.addCleanup(self.transactional.stop)

    def scenario(self):
        return StoreScenario.firestore()

    # **Validates: Requirements 12.1-12.4, 20.2**
    def test_firestore_declares_isolated_collections_and_resolver_reads_paid_pointer_and_grant(self):
        expected = {
            "complimentary_grants": GRANT_COLLECTION,
            "complimentary_users": POINTER_COLLECTION,
            "complimentary_operations": OPERATION_COLLECTION,
            "complimentary_audit": AUDIT_COLLECTION,
        }
        for key, value in expected.items():
            self.assertEqual(
                store_module.COLLECTIONS.get(key),
                value,
                "Task 7 must declare the approved Admin-SDK-only collection %s" % key,
            )

        scenario = self.scenario()
        created = scenario.create()
        scenario.database.events.clear()
        resolved = scenario.resolve()
        self.assertEqual(resolved["effectiveEntitlement"]["source"], "complimentary")
        paths = transaction_read_paths(scenario.database)
        self.assertIn((SUBSCRIPTION_COLLECTION, TARGET["uid"]), paths)
        self.assertIn((POINTER_COLLECTION, TARGET["uid"]), paths)
        self.assertIn((GRANT_COLLECTION, created["grant"]["id"]), paths)

    # **Validates: Requirements 5.1, 5.4-5.5, 9.5, 14.4, 16.3-16.7**
    def test_grant_retry_uses_per_attempt_utc_and_rereads_operation_plan_paid_pointer_and_grant(self):
        scenario = self.scenario()
        prior = scenario.create(key="prior-grant-key-001")
        scenario.database.events.clear()
        first_time = NOW + timedelta(minutes=1)
        second_time = NOW + timedelta(minutes=2)
        clock = SequenceClock(first_time, second_time)
        scenario.clock = clock
        scenario.database.abort_commits = 1

        def mutate_between_attempts(database, _attempt):
            plan = deepcopy(database.store[(PLAN_COLLECTION, PLAN["id"])])
            plan.update({"name": "Pro reread", "revision": 8, "updatedAt": first_time})
            database.store[(PLAN_COLLECTION, PLAN["id"])] = plan
            paid = deepcopy(database.store[(SUBSCRIPTION_COLLECTION, TARGET["uid"])])
            paid["expiresAt"] = second_time + timedelta(days=40)
            database.store[(SUBSCRIPTION_COLLECTION, TARGET["uid"])] = paid

        scenario.database.on_abort = mutate_between_attempts
        result = scenario.create(key="retry-grant-key-0001")
        self.assertEqual(clock.calls, [first_time, second_time])
        self.assertEqual(result["grant"]["activationAt"], second_time.isoformat().replace("+00:00", "Z"))
        self.assertEqual(result["grant"]["planName"], "Pro reread")
        self.assertEqual(
            result["paidFallback"]["expiresAt"],
            (second_time + timedelta(days=40)).isoformat().replace("+00:00", "Z"),
        )

        operation_path = (OPERATION_COLLECTION, operation_id("grant", "retry-grant-key-0001"))
        expected_paths = {
            operation_path,
            (PLAN_COLLECTION, PLAN["id"]),
            (SUBSCRIPTION_COLLECTION, TARGET["uid"]),
            (POINTER_COLLECTION, TARGET["uid"]),
            (GRANT_COLLECTION, prior["grant"]["id"]),
        }
        for attempt in (1, 2):
            reads = transaction_read_paths(scenario.database, attempt)
            self.assertEqual(reads[0], operation_path, "idempotency operation must be read first")
            self.assertTrue(expected_paths.issubset(set(reads)))
            assert_reads_before_writes(self, scenario.database, attempt)

    # **Validates: Requirements 8.2-8.5, 16.1-16.2, 16.5-16.7**
    def test_operation_first_replay_preserves_revision_audits_and_original_response_snapshot(self):
        scenario = self.scenario()
        key = "firestore-replay-key-1"
        created = scenario.create(key=key)
        grant_id = created["grant"]["id"]
        operation = operation_id("grant", key)
        documents_before = scenario.complimentary_snapshot()
        scenario.database.events.clear()

        replay = scenario.create(key=key)
        self.assertTrue(replay["duplicate"])
        self.assertEqual({**replay, "duplicate": False}, created)
        self.assertEqual(scenario.complimentary_snapshot(), documents_before)
        self.assertEqual(
            transaction_read_paths(scenario.database),
            [(OPERATION_COLLECTION, operation)],
            "an identical replay must stop after the operation document",
        )
        self.assertFalse(any(kind == "write" for kind, _attempt, _path in scenario.database.events))
        stored_operation = scenario.documents(OPERATION_COLLECTION)[operation]
        self.assertEqual(stored_operation["responseSnapshot"], created)
        self.assertEqual(
            set(scenario.documents(AUDIT_COLLECTION)),
            {audit_id(operation, "granted", grant_id)},
        )
        self.assertEqual(
            scenario.documents(POINTER_COLLECTION)[TARGET["uid"]]["revision"], 1,
        )

    # **Validates: Requirements 5.5, 9.2-9.5, 14.4**
    def test_firestore_transaction_write_failure_has_no_partial_grant_pointer_operation_or_audit(self):
        scenario = self.scenario()
        before = deepcopy(scenario.database.store)
        scenario.database.fail_on_write = 2
        with self.assertRaises(RuntimeError):
            scenario.create(key="firestore-atomic-key-1")
        self.assertEqual(scenario.database.store, before)
        self.assertEqual(scenario.database.commits, 0)

    # **Validates: Requirements 9.2, 10.1-10.7, 16.3, 20.3**
    def test_payment_transaction_reads_paid_and_shared_grant_pointer_before_writes(self):
        scenario = self.scenario()
        grant = {
            "id": "active-grant-for-payment",
            "targetUid": TARGET["uid"],
            "targetEmail": TARGET["email"],
            "targetEmailNormalized": TARGET["emailNormalized"],
            "targetDisplayName": TARGET["displayName"],
            "planId": PLAN["id"],
            "planSnapshot": core.canonical_plan_snapshot(PLAN),
            "validityType": "lifetime",
            "presetDays": None,
            "activationAt": NOW,
            "expiresAt": None,
            "lifetime": True,
            "storedStatus": "active",
            "createdAt": NOW,
            "updatedAt": NOW,
            "createdBy": deepcopy(ACTOR),
            "reason": None,
            "endedAt": None,
            "endReason": None,
            "revokedBy": None,
            "supersededByGrantId": None,
            "supersededBy": None,
            "creationOperationId": "operation-for-payment",
            "schemaVersion": 1,
        }
        scenario.database.seed(GRANT_COLLECTION, grant["id"], grant)
        scenario.database.seed(POINTER_COLLECTION, TARGET["uid"], {
            "targetUid": TARGET["uid"],
            "activeGrantId": grant["id"],
            "revision": 1,
            "updatedAt": NOW,
            "schemaVersion": 1,
        })
        order = {
            "id": "billing-order-1",
            "userId": TARGET["uid"],
            "userEmail": TARGET["email"],
            "status": "reserved",
            "reservationExpiresAt": NOW + timedelta(minutes=10),
            "planId": "basic",
            "planSnapshot": {
                "id": "basic",
                "name": "Basic",
                "amountPaise": 49900,
                "durationDays": 30,
                "features": ["Dashboard"],
                "entitlementTier": "basic",
            },
            "providerOrderId": "provider-order-1",
            "couponCode": None,
            "couponSnapshot": None,
            "amountPaise": 49900,
            "originalAmountPaise": 49900,
            "discountPaise": 0,
            "createdAt": NOW,
            "updatedAt": NOW,
        }
        scenario.database.seed("billing_orders", order["id"], order)
        provider_payment = {
            "id": "provider-payment-1",
            "method": "card",
            "bank": None,
            "wallet": None,
            "vpa": None,
            "fee": 100,
            "tax": 18,
            "created_at": int(NOW.timestamp()),
        }
        complimentary_before = scenario.complimentary_snapshot()
        paid_before = deepcopy(
            scenario.database.store[(SUBSCRIPTION_COLLECTION, TARGET["uid"])]
        )
        scenario.database.events.clear()
        payment, entitlement, created = scenario.store.activate_payment(
            order, provider_payment, NOW,
        )

        self.assertTrue(created)
        self.assertEqual(payment["providerPaymentId"], provider_payment["id"])
        self.assertEqual(entitlement["effectiveEntitlement"]["source"], "complimentary")
        self.assertEqual(entitlement["effectiveEntitlement"]["grantId"], grant["id"])
        self.assertEqual(entitlement["paidFallback"]["source"], "paid")
        self.assertEqual(entitlement["paidFallback"]["paymentCount"], 3)
        self.assertEqual(
            entitlement["paidFallback"]["expiresAt"],
            (PAID["expiresAt"] + timedelta(days=30)).isoformat().replace("+00:00", "Z"),
        )
        stored_paid = scenario.database.store[(SUBSCRIPTION_COLLECTION, TARGET["uid"])]
        self.assertEqual(stored_paid["startsAt"], paid_before["expiresAt"])
        self.assertEqual(stored_paid["expiresAt"], paid_before["expiresAt"] + timedelta(days=30))
        self.assertEqual(stored_paid["lastPaymentId"], provider_payment["id"])
        self.assertEqual(stored_paid["paymentCount"], paid_before["paymentCount"] + 1)
        self.assertEqual(scenario.complimentary_snapshot(), complimentary_before)

        reads = transaction_read_paths(scenario.database, 1)
        self.assertIn((SUBSCRIPTION_COLLECTION, TARGET["uid"]), reads)
        self.assertIn(
            (POINTER_COLLECTION, TARGET["uid"]),
            reads,
            "payment activation must contend on the same complimentary pointer as grants",
        )
        self.assertIn((GRANT_COLLECTION, grant["id"]), reads)
        assert_reads_before_writes(self, scenario.database, 1)

        # An idempotent replay still resolves from current shared records. At
        # the strict boundary both finite sources are expired, so paid access
        # must not be restored and no payment-domain write is repeated.
        expired_grant = deepcopy(
            scenario.database.store[(GRANT_COLLECTION, grant["id"])]
        )
        expired_grant.update({
            "validityType": "custom",
            "activationAt": NOW - timedelta(days=1),
            "expiresAt": NOW,
            "lifetime": False,
            "createdAt": NOW - timedelta(days=1),
            "updatedAt": NOW - timedelta(days=1),
        })
        scenario.database.store[(GRANT_COLLECTION, grant["id"])] = expired_grant
        boundary_paid = deepcopy(
            scenario.database.store[(SUBSCRIPTION_COLLECTION, TARGET["uid"])]
        )
        boundary_paid["expiresAt"] = NOW
        scenario.database.store[(SUBSCRIPTION_COLLECTION, TARGET["uid"])] = boundary_paid
        scenario.database.events.clear()

        replay_payment, replay_entitlement, replay_created = scenario.store.activate_payment(
            order, provider_payment, NOW,
        )

        self.assertFalse(replay_created)
        self.assertEqual(replay_payment["providerPaymentId"], provider_payment["id"])
        self.assertEqual(replay_entitlement["effectiveEntitlement"]["status"], "inactive")
        self.assertIsNone(replay_entitlement["effectiveEntitlement"]["source"])
        self.assertEqual(replay_entitlement["paidFallback"]["status"], "expired")
        replay_reads = transaction_read_paths(scenario.database, 1)
        self.assertIn((SUBSCRIPTION_COLLECTION, TARGET["uid"]), replay_reads)
        self.assertIn((POINTER_COLLECTION, TARGET["uid"]), replay_reads)
        self.assertIn((GRANT_COLLECTION, grant["id"]), replay_reads)
        self.assertFalse(
            any(kind == "write" for kind, _attempt, _path in scenario.database.events)
        )


if __name__ == "__main__":
    unittest.main()
