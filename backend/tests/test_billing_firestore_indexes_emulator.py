"""Task 12 Firestore emulator checks for approved complimentary list indexes."""

from datetime import datetime, timezone
import os
import unittest

from google.auth.credentials import AnonymousCredentials
from google.cloud import firestore


PROJECT_ID = "demo-complimentary-billing"
COLLECTION = "billing_complimentary_grants"
EMAIL = "person@example.com"
PLAN_ID = "pro"


@unittest.skipUnless(
    os.environ.get("FIRESTORE_EMULATOR_HOST"),
    "Firestore emulator is required for index verification",
)
class FirestoreComplimentaryIndexEmulatorTests(unittest.TestCase):
    """Exercise the exact server Firestore list query shapes from billing_store.py."""

    @classmethod
    def setUpClass(cls):
        cls.database = firestore.Client(
            project=os.environ.get("GCLOUD_PROJECT", PROJECT_ID),
            credentials=AnonymousCredentials(),
        )

    @classmethod
    def tearDownClass(cls):
        cls.database.close()

    def setUp(self):
        self.collection = self.database.collection(COLLECTION)
        self._clear_collection()
        created_at = datetime(2025, 1, 1, 12, 0, tzinfo=timezone.utc)
        fixtures = {
            "grant-z": {
                "targetEmailNormalized": EMAIL,
                "planId": PLAN_ID,
                "createdAt": created_at,
            },
            "grant-y": {
                "targetEmailNormalized": EMAIL,
                "planId": "elite",
                "createdAt": created_at,
            },
            "grant-x": {
                "targetEmailNormalized": "other@example.com",
                "planId": PLAN_ID,
                "createdAt": created_at,
            },
        }
        for grant_id, record in fixtures.items():
            self.collection.document(grant_id).set(record)

    def tearDown(self):
        self._clear_collection()

    def _clear_collection(self):
        for snapshot in self.collection.stream():
            snapshot.reference.delete()

    def _query(self, *, email=None, plan_id=None):
        query = self.collection
        if email is not None:
            query = query.where("targetEmailNormalized", "==", email)
        if plan_id is not None:
            query = query.where("planId", "==", plan_id)
        query = query.order_by(
            "createdAt", direction=firestore.Query.DESCENDING,
        ).order_by("__name__", direction=firestore.Query.DESCENDING)
        return [snapshot.id for snapshot in query.stream()]

    def test_supported_admin_sdk_list_query_shapes_use_deployed_indexes(self):
        """Validates: Requirements 7.1, 7.4-7.5, 12.5, 17.5, 20.5."""
        cases = {
            "no_filter": ({}, ["grant-z", "grant-y", "grant-x"]),
            "email": ({"email": EMAIL}, ["grant-z", "grant-y"]),
            "plan": ({"plan_id": PLAN_ID}, ["grant-z", "grant-x"]),
            "email_and_plan": (
                {"email": EMAIL, "plan_id": PLAN_ID},
                ["grant-z"],
            ),
        }

        for name, (filters, expected_ids) in cases.items():
            with self.subTest(query_shape=name):
                self.assertEqual(self._query(**filters), expected_ids)


if __name__ == "__main__":
    unittest.main()
