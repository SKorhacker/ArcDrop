// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Minimal subset of Circle's FiatToken v2 (USDC, EURC on Arc).
interface IFiatToken {
    function receiveWithAuthorization(
        address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce,
        uint8 v, bytes32 r, bytes32 s
    ) external;
    function transfer(address to, uint256 value) external returns (bool);
}

/// ArcDrop tabs ("ardoises"): guaranteed offline payments to a known recipient.
///
/// Online, once: a payer locks funds for ONE recipient until an expiry.
/// Offline, then: each payment to that recipient is a signed voucher carrying the
/// cumulative amount owed so far. The recipient (or anyone) redeems the latest
/// voucher; the contract pays the difference with what was already paid.
///
/// Why it is a guarantee: locked funds can only ever go to that recipient before
/// expiry. The payer cannot pull them back early, redirect them, or redeem them to
/// another wallet of their own. A recipient holding a voucher for C is paid
/// min(C, locked) as long as they (or any relay) redeem before expiry.
///
/// One-way payment channel: older vouchers are harmless (lower cumulative amount),
/// and each tab has an epoch so vouchers from a closed tab never pay out again.
contract ArcDropTabs {
    uint256 public constant MIN_DURATION = 1 hours;
    uint256 public constant MAX_DURATION = 30 days;
    uint256 public constant MIN_LOCK = 1e5; // 0.1 token (6 decimals): no dust tabs

    bytes32 public constant VOUCHER_TYPEHASH =
        keccak256("TabVoucher(address token,address from,address to,uint64 epoch,uint256 cumulative)");
    /// The EIP-3009 nonce used to fund a tab commits to its recipient and expiry, so a
    /// copied funding signature cannot be replayed to open a tab for someone else.
    bytes32 public constant FUND_TYPEHASH = keccak256("TabFunding(address to,uint256 expiry,bytes32 salt)");
    bytes32 public immutable DOMAIN_SEPARATOR;
    /// The only tokens tabs accept: a fake token could otherwise emit "funded" events and
    /// fill recipients' payer lists for free.
    address public immutable USDC;
    address public immutable EURC;
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    struct Tab {
        uint128 locked;   // total ever locked for this recipient
        uint128 paid;     // total already paid to the recipient
        uint64 expiry;    // after this, only the payer can act (close)
        uint64 epoch;     // bumped on close: vouchers of a closed tab are dead
    }

    /// token => payer => recipient => tab
    mapping(address => mapping(address => mapping(address => Tab))) public tabs;
    /// token => recipient => payers who ever funded a tab for them (so a recipient can
    /// find, while online, the tabs that guarantee the payments they will receive offline)
    mapping(address => mapping(address => address[])) private _payersOf;
    mapping(address => mapping(address => mapping(address => bool))) private _listed;

    event TabFunded(address indexed token, address indexed from, address indexed to, uint256 locked, uint256 expiry);
    event TabRedeemed(address indexed token, address indexed from, address indexed to, uint256 amount, uint256 cumulative);
    event TabClosed(address indexed token, address indexed from, address indexed to, uint256 refunded);

    error BadDuration();
    error TooSmall();
    error BadSignature();
    error Expired();
    error NotExpired();
    error NothingToPay();
    error SelfTab();
    error TransferFailed();
    error UnknownToken();

    function _known(address token) private view {
        if (token != USDC && token != EURC) revert UnknownToken();
    }

    constructor(address usdc, address eurc) {
        USDC = usdc;
        EURC = eurc;
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("ArcDropTabs"), keccak256("1"), block.chainid, address(this)
        ));
    }

    /// Locks `value` for `to` until at least `expiry`, pulled from `from` with their
    /// EIP-3009 signature (`to` of the authorization = this contract). Anyone may submit.
    /// Topping up an existing tab adds funds; the expiry can only move later.
    function fund(
        address token, address from, address to, uint256 expiry, bytes32 salt,
        uint256 value, uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s
    ) external {
        _known(token);
        if (to == from || to == address(0) || to == address(this)) revert SelfTab();
        if (value < MIN_LOCK || value > type(uint128).max) revert TooSmall();
        if (expiry < block.timestamp + MIN_DURATION || expiry > block.timestamp + MAX_DURATION) revert BadDuration();
        // The payer signed (from, to=this, value, nonce) and nonce = hash(recipient, expiry, salt):
        // changing the recipient or the expiry breaks the signature.
        bytes32 nonce = keccak256(abi.encode(FUND_TYPEHASH, to, expiry, salt));
        IFiatToken(token).receiveWithAuthorization(from, address(this), value, validAfter, validBefore, nonce, v, r, s);

        Tab storage t = tabs[token][from][to];
        if (!_listed[token][to][from]) {
            _listed[token][to][from] = true;
            _payersOf[token][to].push(from);
        }
        t.locked += uint128(value);
        if (expiry > t.expiry) t.expiry = uint64(expiry);
        emit TabFunded(token, from, to, t.locked, t.expiry);
    }

    /// Pays `to` up to the cumulative amount signed by `from`. Anyone may submit;
    /// the money can only go to `to`.
    function redeem(address token, address from, address to, uint256 cumulative, uint8 v, bytes32 r, bytes32 s) external {
        _known(token);
        Tab storage t = tabs[token][from][to];
        if (block.timestamp >= t.expiry) revert Expired();
        if (uint256(s) > HALF_N) revert BadSignature();
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01", DOMAIN_SEPARATOR, keccak256(abi.encode(VOUCHER_TYPEHASH, token, from, to, t.epoch, cumulative))
        ));
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != from) revert BadSignature();

        uint256 owed = cumulative < t.locked ? cumulative : t.locked;
        if (owed <= t.paid) revert NothingToPay();
        uint256 amount = owed - t.paid;
        t.paid = uint128(owed);
        if (!IFiatToken(token).transfer(to, amount)) revert TransferFailed();
        emit TabRedeemed(token, from, to, amount, cumulative);
    }

    /// Payers who funded tabs for `to`, newest last; paginated because anyone can add to it.
    function payersOf(address token, address to, uint256 start, uint256 count) external view returns (address[] memory page, uint256 total) {
        address[] storage all = _payersOf[token][to];
        total = all.length;
        if (start >= total) return (new address[](0), total);
        uint256 end = start + count > total ? total : start + count;
        page = new address[](end - start);
        for (uint256 i = start; i < end; i++) page[i - start] = all[i];
    }

    /// After expiry, the payer takes back what was not paid out.
    function close(address token, address to) external {
        closeTo(token, to, msg.sender);
    }

    /// Same, refunded to another address of the payer's choosing (e.g. if the payer's own
    /// address can no longer receive the token).
    function closeTo(address token, address to, address refundTo) public {
        _known(token);
        Tab storage t = tabs[token][msg.sender][to];
        if (t.expiry == 0 || block.timestamp < t.expiry) revert NotExpired();
        uint256 refund = t.locked - t.paid;
        t.locked = 0;
        t.paid = 0;
        t.expiry = 0;
        t.epoch += 1;
        if (refund > 0 && !IFiatToken(token).transfer(refundTo, refund)) revert TransferFailed();
        emit TabClosed(token, msg.sender, to, refund);
    }
}
