"""Component/host integration checks against a local core checkout; no real payments."""
import asyncio
from contextlib import nullcontext
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch
from uuid import uuid4


ROOT = Path(os.environ.get("POS_ARTIFACT_ROOT", Path(__file__).resolve().parents[1])).resolve()
CORE = Path(os.environ["LNBITS_CORE_PATH"]).resolve()


async def check(contracts_only):
    from lnbits.core.helpers import migrate_databases
    from lnbits.core.models.extensions import InstallableExtension
    from lnbits.core.models.payments import Payment
    from lnbits.core.models.wallets import Wallet
    from lnbits.core.wasm_ext.api.host import ExtensionHostAPI
    from lnbits.core.wasm_ext.api.models import (
        CreateInvoicePublicRequest, InvoiceStatusRequest, StorageGetRequest,
        StorageSetRequest,
    )
    from lnbits.core.wasm_ext.storage import migrate_wasm_extension_database
    from lnbits.core.wasm_ext.wasm.config import parse_wasm_extension_config
    from lnbits.helpers import sha256s

    config = parse_wasm_extension_config("pos", json.loads((ROOT / "config.json").read_text()))
    installed = InstallableExtension(id="pos", name=config.name, version=config.version, active=True, permissions=config.permissions)
    await migrate_databases()
    await migrate_wasm_extension_database(installed)
    alice = ExtensionHostAPI("pos", config.permissions, user_id="alice")
    bob = ExtensionHostAPI("pos", config.permissions, user_id="bob")
    public = ExtensionHostAPI("pos", config.permissions, owner_id=sha256s("alice"), context="event")
    source = {"id": "contract_source", "wallet": "alice_wallet"}
    await alice.storage_set(StorageSetRequest(table="tip_sources", data=source))
    request = StorageGetRequest(table="tip_sources", id=source["id"])
    assert (await bob.storage_get(request)).data_json is None
    await bob.storage_set(StorageSetRequest(table="tip_sources", data={**source, "wallet": "bob_wallet"}))
    assert json.loads((await alice.storage_get(request)).data_json)["wallet"] == "alice_wallet"

    wallets = {f"{owner}_wallet": Wallet(id=f"{owner}_wallet", user=owner, name="Test wallet", adminkey="test-admin", inkey="test-invoice") for owner in ["alice", "bob"]}
    payments = {}

    async def create_payment(wallet_id, invoice, *, extension_context):
        payment_hash = uuid4().hex + uuid4().hex
        payment = Payment(checking_id=payment_hash, payment_hash=payment_hash, wallet_id=wallet_id, amount=int(invoice.amount * 1000), fee=0, bolt11="test-invoice", extension="pos", extension_context=extension_context)
        payments[payment_hash] = payment
        return payment

    async def refresh(payment):
        payment.status = "success"
        return payment

    with (
        patch("lnbits.core.crud.wallets.get_wallet", AsyncMock(side_effect=lambda wallet_id: wallets.get(wallet_id))),
        patch("lnbits.core.crud.wallets.get_wallets", AsyncMock(side_effect=lambda owner: [w for w in wallets.values() if w.user == owner])),
        # Newer core moved the wallet list into onchain and imports CRUD eagerly.
        patch("lnbits.core.wasm_ext.api.onchain.get_wallets", AsyncMock(side_effect=lambda owner: [w for w in wallets.values() if w.user == owner])) if (CORE / "lnbits/core/wasm_ext/api/onchain.py").exists() else nullcontext(),
        patch("lnbits.core.services.payments.create_payment_request", create_payment),
        patch("lnbits.core.crud.payments.get_standalone_payment", AsyncMock(side_effect=lambda payment_hash, **kwargs: payments.get(payment_hash))),
        patch("lnbits.core.services.payments.update_pending_payment", refresh),
    ):
        invoice = await public.wallet_create_invoice_public(CreateInvoicePublicRequest(source_id=source["id"], amount=100, currency="sat", memo="Contract check"))
        status_request = InvoiceStatusRequest(payment_hash=invoice.payment_hash, source_id=source["id"])
        assert (await public.wallet_invoice_status(status_request)).pending
        try:
            await bob.wallet_invoice_status(status_request)
        except PermissionError:
            pass
        else:
            raise AssertionError("Another owner could read this invoice")
        await alice.storage_set(StorageSetRequest(table="tip_sources", data={"id": "wrong_wallet_source", "wallet": "bob_wallet"}))
        try:
            await public.wallet_create_invoice_public(CreateInvoicePublicRequest(source_id="wrong_wallet_source", amount=100, currency="sat", memo="Blocked"))
        except PermissionError:
            pass
        else:
            raise AssertionError("A source could use another owner's wallet")
        print("PASS: core config, real migrations, private storage and bound invoice permissions")
        if contracts_only:
            return

        from lnbits.core.wasm_ext.wasm.invoke import _invoke_wasm_extension_export_sync
        from lnbits.core.wasm_ext.wasm.loader import load_wasm_extension
        from lnbits.settings import settings

        extension = load_wasm_extension("pos")
        limits = {key: value for key, value in settings.model_dump().items() if key.startswith("wasm_runtime_")}
        loop = asyncio.get_running_loop()

        async def call(export, data, api=alice, ok=True):
            result = await asyncio.to_thread(_invoke_wasm_extension_export_sync, extension, export, data, api, loop, "pos-integration-test", limits)
            assert result["ok"] is ok, result
            return result.get("data")

        metadata = await call("metadata", {})
        assert [w["id"] for w in metadata["wallets"]] == ["alice_wallet"]
        terminal = await call("save-terminal", {"name": "Test counter", "currency": "sat", "wallet": "alice_wallet", "remote_enabled": True, "products": [{"id": "product_coffee", "title": "Coffee", "price": "100"}]})
        await call("terminal-settings", {"id": terminal["id"]}, bob, ok=False)
        await call("save-terminal", {"name": "Foreign", "currency": "sat", "wallet": "alice_wallet"}, bob, ok=False)
        assert await call("list-terminals", {}, bob) == []
        await call("get-terminal", {"link": terminal["cashier_link"]}, public)
        payload = {"link": terminal["cashier_link"], "action_id": "component_action_1", "method": "lightning", "items": [{"product_id": "product_coffee", "quantity": 1}]}
        checkout = await call("create-checkout", payload, public)
        duplicate = await call("create-checkout", payload, public)
        assert checkout["id"] == duplicate["id"]
        assert checkout["amount_sat"] == 100
        from starlette.requests import Request
        from lnbits.core.wasm_ext.routes.api import _read_api_payload
        request = Request({"type": "http", "method": "GET", "path_params": {"link": terminal["cashier_link"]}, "query_string": f"checkout_id={checkout['id']}".encode(), "headers": []})
        route_payload = await _read_api_payload(request, {"link": "link"}, max_body_bytes=1024)
        status = await call("checkout-status", route_payload.data, public)
        assert status["status"] == "pending"
        await call("create-checkout", {**payload, "link": terminal["display_link"]}, public, ok=False)
        paid = await call("reconcile", {"id": terminal["id"], "checkout_id": checkout["id"]})
        assert paid["status"] == "paid"
        payment = payments[checkout["payment_hash"]]
        event = {"extension": "pos", "walletId": "alice_wallet", "paymentHash": payment.payment_hash, "pending": False, "status": "success", "payment": json.loads(payment.model_dump_json())}
        assert (await call("record-payment", event, public))["recorded"]
        await call("rotate-links", {"id": terminal["id"]})
        await call("get-terminal", {"link": terminal["cashier_link"]}, public, ok=False)
        print("PASS: compiled WASM, real host imports, two-owner isolation, checkout retries and paid event")


def main():
    if not (CORE / "lnbits/core/wasm_ext").is_dir():
        raise SystemExit("LNBITS_CORE_PATH must point to a core checkout with WASM support.")
    with TemporaryDirectory(prefix="pos-host-test-") as temporary:
        data = Path(temporary)
        os.chdir(data)
        os.environ.update(LNBITS_DATA_FOLDER=str(data), LNBITS_WASM_EXTENSIONS_PATH=str(data / "wasm_extensions"), LNBITS_DATABASE_URL="", LNBITS_BACKEND_WALLET_CLASS="FakeWallet", LNBITS_ADMIN_UI="false", LNBITS_EXTENSIONS_DEFAULT_INSTALL="[]")
        (data / "wasm_extensions").mkdir()
        (data / "wasm_extensions/pos").symlink_to(ROOT, target_is_directory=True)
        sys.path.insert(0, str(CORE))
        asyncio.run(check("--contracts-only" in sys.argv))


if __name__ == "__main__":
    main()
