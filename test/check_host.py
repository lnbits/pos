"""Component/host integration checks against a local core checkout; no real payments."""
import asyncio
from contextlib import nullcontext
from importlib import import_module
import json
import os
from pathlib import Path
import sys
import time
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

    onchain = import_module("lnbits.core.wasm_ext.api.onchain") if (CORE / "lnbits/core/wasm_ext/api/onchain.py").exists() else None
    owned_wallets = AsyncMock(side_effect=lambda owner, **kwargs: [w for w in wallets.values() if w.user == owner])
    with (
        patch("lnbits.core.crud.wallets.get_wallet", AsyncMock(side_effect=lambda wallet_id: wallets.get(wallet_id))),
        patch("lnbits.core.crud.wallets.get_wallets", owned_wallets),
        # Some dev commits imported this eagerly before moving it back to host.
        patch.object(onchain, "get_wallets", owned_wallets) if hasattr(onchain, "get_wallets") else nullcontext(),
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
        await call("delete-terminal", {"id": terminal["id"]}, bob, ok=False)
        await call("delete-terminal", {"id": terminal["id"]})
        assert await call("list-terminals", {}) == []
        assert (await call("sales", {}))["total"] == 1
        assert (await call("sales", {}, bob))["total"] == 0
        assert (await call("sale-receipt", {"checkoutId": checkout["id"]}))["status"] == "paid"
        await call("sale-receipt", {"checkoutId": checkout["id"]}, bob, ok=False)
        assert (await call("reconcile", {"checkout_id": checkout["id"]}))["status"] == "paid"
        assert (await call("sales-rate", {"currency": "sat"}))["rate"] == 1
        print("PASS: compiled WASM, real host imports, two-owner isolation, checkout retries and paid event")
        await _check_onchain(call, alice, bob, public, wallets)


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


async def _check_onchain(call, alice, bob, public, wallets):
    from lnbits.core.crud.onchain import get_address, update_address_snapshot
    from lnbits.core.crud.wallets import create_wallet, get_onchain_wallet, init_onchain_wallet_state
    from lnbits.core.db import db
    from lnbits.core.models.onchain import Snapshot
    from lnbits.core.models.wallets import WalletType
    from lnbits.core.services.onchain import OnchainKeyStatus, get_fresh_address
    from lnbits.core.wasm_ext.api.models import StorageGetRequest
    from lnbits.core.wasm_ext.api.onchain import ReserveOnchainAddressPublicRequest
    from lnbits.settings import settings
    from lnbits.utils.onchain import new_mnemonic, wallet_descriptor

    settings.lnbits_allow_onchain_payments = True
    settings.auth_secret_key = "pos-disposable-onchain-test-key"
    chain_wallets = {}
    for owner in ("alice", "bob"):
        base = await create_wallet(user_id=owner, wallet_type=WalletType.ONCHAIN, onchain_network="Testnet4")
        wallet = await get_onchain_wallet(base.id)
        assert wallet
        wallet.onchain_wallet_kind = "watch"
        wallet.onchain_meta.masterpub = wallet_descriptor(new_mnemonic(), "Testnet4")[0]
        wallet = await init_onchain_wallet_state(wallet)
        wallets[wallet.id] = wallet
        chain_wallets[owner] = wallet

    async def snapshot(checkout, confirmed, unconfirmed, *, stale=False):
        address = await get_address(checkout["onchain"]["address"])
        assert address
        checked_at = int(time.time()) - (86400 if stale else 0)
        transactions = [{"txid": digit * 64, "status": {"confirmed": settled, "block_height": 100 if settled else None}, "vout": [{"scriptpubkey_address": address.address, "value": amount}]} for digit, settled, amount in [("a", True, confirmed), ("b", False, unconfirmed)] if amount]
        await update_address_snapshot(Snapshot(address_id=address.id, transactions=transactions, utxos=[], checked_at=checked_at), amount=0)
        wallet = chain_wallets["alice"]
        wallet.onchain_meta.sync_checked_at = checked_at
        await db.execute("UPDATE wallets SET onchain_meta = :meta WHERE id = :id", {"id": wallet.id, "meta": wallet.onchain_meta.model_dump_json()})

    with (
        patch("lnbits.core.services.onchain.onchain_key_status", AsyncMock(return_value=OnchainKeyStatus(configured=True, backup_confirmed=True))),
        patch("lnbits.core.wasm_ext.api.onchain.get_fresh_address", AsyncMock(wraps=get_fresh_address)) as reserve,
    ):
        metadata = await call("metadata", {})
        summary = next(w for w in metadata["wallets"] if w["id"] == chain_wallets["alice"].id)
        assert summary["wallet_type"] == "onchain" and summary["receiving_ready"] is True
        assert summary["onchain_network"] == "Testnet4"
        assert chain_wallets["bob"].id not in [w["id"] for w in metadata["wallets"]]
        settings_input = {"name": "On-chain counter", "currency": "sat", "wallet": "alice_wallet", "remote_enabled": True, "onchain_enabled": True, "onchain_wallet_id": chain_wallets["alice"].id, "products": [{"id": "product_chain", "title": "Coffee", "price": "100"}]}
        await call("save-terminal", {**settings_input, "onchain_wallet_id": chain_wallets["bob"].id}, ok=False)
        terminal = await call("save-terminal", settings_input)
        payload = {"link": terminal["cashier_link"], "action_id": "chain_action_1", "method": "onchain", "items": [{"product_id": "product_chain", "quantity": 1}]}
        checkout = await call("create-checkout", payload, public)
        assert checkout["status"] == "pending" and checkout["onchain"]["network"] == "Testnet4"
        assert checkout["payment_request"] == f"bitcoin:{checkout['onchain']['address']}?amount=0.00000100"
        assert (await call("create-checkout", payload, public)) == checkout
        assert reserve.await_count == 1
        address = await get_address(checkout["onchain"]["address"])
        assert address and address.walet_id == chain_wallets["alice"].id
        status_input = {"link": terminal["cashier_link"], "checkoutId": checkout["id"]}
        try:
            await call("checkout-status", status_input, public)
        except ValueError:
            pass  # Core traps when no fresh scan exists; the QR stays readable.
        else:
            raise AssertionError("Core accepted a missing scan")
        saved = await call("get-terminal", status_input, public)
        assert saved["latest"]["payment_request"] == checkout["payment_request"]
        assert saved["latest"]["status"] == "pending"
        await call("create-checkout", {**payload, "link": terminal["display_link"]}, public, ok=False)
        await call("checkout-status", status_input, bob, ok=False)
        private = StorageGetRequest(table="checkouts", id=checkout["id"])
        assert (await bob.storage_get(private)).data_json is None
        stored = json.loads((await alice.storage_get(private)).data_json)
        token = json.loads(stored["data_json"])["onchain"]["status_token"]
        assert token not in json.dumps(checkout)
        for source_id, api in [("wrong_terminal", public), (terminal["id"], bob)]:
            try:
                await api.onchain.reserve_address_public(ReserveOnchainAddressPublicRequest(table="checkouts", source_id=source_id, checkout_id=checkout["id"]))
            except PermissionError:
                pass
            else:
                raise AssertionError("Core accepted a mismatched checkout binding")
        assert reserve.await_count == 1
        await snapshot(checkout, 0, 100)
        pending = await call("checkout-status", status_input, public)
        assert pending["status"] == "pending" and pending["onchain"]["received_sat"] == 100
        await snapshot(checkout, 100, 0, stale=True)
        try:
            await call("checkout-status", status_input, public)
        except ValueError:
            pass
        else:
            raise AssertionError("Core accepted a stale scan")
        stale = await call("get-terminal", {"link": terminal["display_link"]}, public)
        assert stale["latest"]["status"] == "pending"
        assert stale["latest"]["payment_request"] == checkout["payment_request"]
        await snapshot(checkout, 110, 0)
        paid = await call("reconcile", {"id": terminal["id"], "checkout_id": checkout["id"]})
        assert paid["status"] == "paid" and paid["onchain"]["confirmed_sat"] == 110
        display = await call("get-terminal", {"link": terminal["display_link"]}, public)
        assert display["latest"]["status"] == "paid" and token not in json.dumps(display)
        zero = await call("save-terminal", {**settings_input, "onchain_zero_conf": True})
        zero_checkout = await call("create-checkout", {**payload, "link": zero["cashier_link"]}, public)
        assert zero_checkout["onchain"]["address"] != checkout["onchain"]["address"]
        await snapshot(zero_checkout, 50, 60)
        zero_paid = await call("checkout-status", {"link": zero["cashier_link"], "checkoutId": zero_checkout["id"]}, public)
        assert zero_paid["status"] == "paid" and zero_paid["onchain"]["confirmed_sat"] == 50
        assert reserve.await_count == 2
        uncertain = await call("save-terminal", {**settings_input, "name": "Uncertain allocation"})
        uncertain_input = {**payload, "link": uncertain["cashier_link"]}

        async def lose_allocation(*args, **kwargs):
            await get_fresh_address(*args, **kwargs)
            raise ValueError("Simulated lost allocation response")

        with patch("lnbits.core.wasm_ext.api.onchain.get_fresh_address", AsyncMock(side_effect=lose_allocation)) as lost:
            try:
                await call("create-checkout", uncertain_input, public)
            except ValueError:
                pass
            else:
                raise AssertionError("Uncertain allocation returned a checkout")
            retry = await call("create-checkout", uncertain_input, public)
            assert retry["status"] == "creating" and retry["payment_request"] == ""
            assert retry["onchain"] is None and lost.await_count == 1
        await call("rotate-links", {"id": terminal["id"]})
        await call("checkout-status", status_input, public, ok=False)
    print("PASS: compiled on-chain imports, real address allocation and tokens, owner isolation, retry reuse, uncertain allocation, stale scans, confirmation rules and display")


if __name__ == "__main__":
    main()
