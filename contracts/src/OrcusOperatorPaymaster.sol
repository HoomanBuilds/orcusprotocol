// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.28;

import {BasePaymaster} from "@account-abstraction/contracts/core/BasePaymaster.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {_packValidationData} from "@account-abstraction/contracts/core/Helpers.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

contract OrcusOperatorPaymaster is BasePaymaster, Ownable2Step, EIP712 {
    uint48 public constant MAX_VALIDITY_SECONDS = 300;
    bytes32 private constant SPONSORSHIP_TYPEHASH = keccak256(
        "Sponsorship(address sender,uint256 nonce,bytes32 initCodeHash,bytes32 callDataHash,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes32 paymasterGasLimits,address entryPoint,uint48 validUntil,uint48 validAfter,uint256 maxCost)"
    );
    uint256 private constant AUTHORIZATION_LENGTH = 96;
    uint256 private constant SIGNATURE_LENGTH = 65;

    address public verifyingSigner;
    uint256 public maxOperationCostWei;

    error InvalidSigner();
    error InvalidOwner();
    error InvalidCostLimit();
    error InvalidAuthorization();
    error SponsorshipCostExceeded();
    error OwnershipRenunciationDisabled();

    event VerifyingSignerChanged(address indexed oldSigner, address indexed newSigner);
    event MaxOperationCostChanged(uint256 oldMaxCostWei, uint256 newMaxCostWei);

    constructor(IEntryPoint entryPoint_, address initialOwner, address initialSigner, uint256 initialMaxOperationCostWei)
        BasePaymaster(entryPoint_)
        EIP712("OrcusOperatorPaymaster", "1")
    {
        if (initialOwner == address(0)) revert InvalidOwner();
        _transferOwnership(initialOwner);
        _setVerifyingSigner(initialSigner);
        _setMaxOperationCostWei(initialMaxOperationCostWei);
    }

    function setVerifyingSigner(address signer) external onlyOwner {
        _setVerifyingSigner(signer);
    }

    function setMaxOperationCostWei(uint256 maxCostWei) external onlyOwner {
        _setMaxOperationCostWei(maxCostWei);
    }

    function renounceOwnership() public pure override {
        revert OwnershipRenunciationDisabled();
    }

    function transferOwnership(address newOwner) public override(Ownable, Ownable2Step) onlyOwner {
        if (newOwner == address(0)) revert InvalidOwner();
        Ownable2Step.transferOwnership(newOwner);
    }

    function _transferOwnership(address newOwner) internal override(Ownable, Ownable2Step) {
        Ownable2Step._transferOwnership(newOwner);
    }

    function getSponsorshipHash(PackedUserOperation calldata userOp, uint48 validUntil, uint48 validAfter, uint256 maxCost)
        public view returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(
            SPONSORSHIP_TYPEHASH,
            userOp.sender,
            userOp.nonce,
            keccak256(userOp.initCode),
            keccak256(userOp.callData),
            userOp.accountGasLimits,
            userOp.preVerificationGas,
            userOp.gasFees,
            bytes32(userOp.paymasterAndData[PAYMASTER_VALIDATION_GAS_OFFSET:PAYMASTER_DATA_OFFSET]),
            address(entryPoint),
            validUntil,
            validAfter,
            maxCost
        )));
    }

    function _validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256 requiredPreFund)
        internal view override returns (bytes memory context, uint256 validationData)
    {
        if (userOp.paymasterAndData.length != PAYMASTER_DATA_OFFSET + AUTHORIZATION_LENGTH + SIGNATURE_LENGTH) revert InvalidAuthorization();
        if (address(bytes20(userOp.paymasterAndData[:20])) != address(this)) revert InvalidAuthorization();
        (uint48 validUntil, uint48 validAfter, uint256 maxCost) = abi.decode(
            userOp.paymasterAndData[PAYMASTER_DATA_OFFSET:PAYMASTER_DATA_OFFSET + AUTHORIZATION_LENGTH],
            (uint48, uint48, uint256)
        );
        if (validUntil <= validAfter || validUntil - validAfter > MAX_VALIDITY_SECONDS || maxCost == 0) revert InvalidAuthorization();
        if (maxCost > maxOperationCostWei || requiredPreFund > maxCost) revert SponsorshipCostExceeded();
        bytes calldata signature = userOp.paymasterAndData[PAYMASTER_DATA_OFFSET + AUTHORIZATION_LENGTH:];
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(getSponsorshipHash(userOp, validUntil, validAfter, maxCost), signature);
        return ("", _packValidationData(error != ECDSA.RecoverError.NoError || recovered != verifyingSigner, validUntil, validAfter));
    }

    function _setVerifyingSigner(address signer) private {
        if (signer == address(0)) revert InvalidSigner();
        emit VerifyingSignerChanged(verifyingSigner, signer);
        verifyingSigner = signer;
    }

    function _setMaxOperationCostWei(uint256 maxCostWei) private {
        if (maxCostWei == 0) revert InvalidCostLimit();
        emit MaxOperationCostChanged(maxOperationCostWei, maxCostWei);
        maxOperationCostWei = maxCostWei;
    }
}
