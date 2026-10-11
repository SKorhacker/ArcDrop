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

/// ArcDrop offline vault.
///
/// A plain offline payment (EIP-3009) is only a promise: the payer can still
/// move their funds online before the payment reaches Arc. Here the payer
/// locks funds first. Offline payments are vouchers drawn on the vault, and a
/// withdrawal needs WITHDRAW_DELAY of notice, so every voucher already in
/// flight has time to be redeemed. Vouchers are signed EIP-712 messages that
/// name the recipient, so whoever relays one cannot redirect it.
///
/// Limit: a payer who signs vouchers for more than their vault balance can
/// still short the last recipients; the official app never signs past it.
contract ArcDropVault {
    uint256 public constant WITHDRAW_DELAY = 1 days;

    bytes32 public constant VOUCHER_TYPEHASH = keccak256(
        "Voucher(address token,address from,address to,uint256 value,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR;

    /// token => owner => locked balance
    mapping(address => mapping(address => uint256)) public balanceOf;
    /// token => owner => amount announced for withdrawal, and when it unlocks
    mapping(address => mapping(address => uint256)) public withdrawAmount;
    mapping(address => mapping(address => uint256)) public withdrawUnlocksAt;
    /// owner => voucher nonce => redeemed
    mapping(address => mapping(bytes32 => bool)) public voucherUsed;

    event Deposited(address indexed token, address indexed owner, uint256 value);
    event Redeemed(address indexed token, address indexed from, address indexed to, uint256 value, bytes32 nonce);
    event WithdrawRequested(address indexed token, address indexed owner, uint256 value, uint256 unlocksAt);
    event Withdrawn(address indexed token, address indexed owner, uint256 value);

    error Expired();
    error AlreadyRedeemed();
    error BadSignature();
    error InsufficientVault();
    error StillLocked();
    error TransferFailed();

    constructor() {
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("ArcDropVault"), keccak256("1"), block.chainid, address(this)
        ));
    }

    /// Locks `value` of `token` for `from`, pulled with their EIP-3009 signature
    /// (`to` = this vault). Anyone may submit it, e.g. a gateway paying the gas.
    function depositWithAuthorization(
        address token, address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce,
        uint8 v, bytes32 r, bytes32 s
    ) external {
        IFiatToken(token).receiveWithAuthorization(from, address(this), value, validAfter, validBefore, nonce, v, r, s);
        balanceOf[token][from] += value;
        emit Deposited(token, from, value);
    }

    /// Pays a voucher signed offline by `from` to `to`. Anyone may submit it.
    function redeem(
        address token, address from, address to, uint256 value, uint256 validBefore, bytes32 nonce,
        uint8 v, bytes32 r, bytes32 s
    ) external {
        if (block.timestamp >= validBefore) revert Expired();
        if (voucherUsed[from][nonce]) revert AlreadyRedeemed();
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01", DOMAIN_SEPARATOR,
            keccak256(abi.encode(VOUCHER_TYPEHASH, token, from, to, value, validBefore, nonce))
        ));
        // Reject malleable signatures (upper-half s).
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != from) revert BadSignature();
        uint256 locked = balanceOf[token][from];
        if (locked < value) revert InsufficientVault();

        voucherUsed[from][nonce] = true;
        balanceOf[token][from] = locked - value;
        // A pending withdrawal can never exceed what is left.
        if (withdrawAmount[token][from] > locked - value) withdrawAmount[token][from] = locked - value;
        if (!IFiatToken(token).transfer(to, value)) revert TransferFailed();
        emit Redeemed(token, from, to, value, nonce);
    }

    /// Announces a withdrawal. Funds stay redeemable by vouchers until it unlocks.
    function requestWithdraw(address token, uint256 value) external {
        if (value > balanceOf[token][msg.sender]) revert InsufficientVault();
        uint256 unlocksAt = block.timestamp + WITHDRAW_DELAY;
        withdrawAmount[token][msg.sender] = value;
        withdrawUnlocksAt[token][msg.sender] = unlocksAt;
        emit WithdrawRequested(token, msg.sender, value, unlocksAt);
    }

    function withdraw(address token) external {
        uint256 unlocksAt = withdrawUnlocksAt[token][msg.sender];
        if (unlocksAt == 0 || block.timestamp < unlocksAt) revert StillLocked();
        uint256 value = withdrawAmount[token][msg.sender];
        uint256 locked = balanceOf[token][msg.sender];
        if (value > locked) value = locked;
        withdrawAmount[token][msg.sender] = 0;
        withdrawUnlocksAt[token][msg.sender] = 0;
        balanceOf[token][msg.sender] = locked - value;
        if (!IFiatToken(token).transfer(msg.sender, value)) revert TransferFailed();
        emit Withdrawn(token, msg.sender, value);
    }
}
