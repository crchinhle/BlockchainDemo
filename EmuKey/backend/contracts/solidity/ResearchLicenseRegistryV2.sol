// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// Independent research implementation of NCKH sections 3.3–3.5.
/// No relayer privilege: every mutation is authorized by msg.sender.
contract ResearchLicenseRegistryV2 {
    struct License {
        bytes16 product;
        address issuer;
        address owner;
        uint64 expiresAt;
        uint32 maxDevices;
        uint32 activeDevices;
        bool revoked;
        bool transferable;
        uint64 version;
        uint64 generation;
    }
    struct Request { bytes32 payload; uint64 version; bool processed; }
    address public immutable administrator;
    uint32 public immutable maximumDevices;
    mapping(bytes16 => address) public issuers;
    mapping(bytes16 => License) private licenses;
    mapping(bytes16 => mapping(uint64 => mapping(bytes32 => bool))) private members;
    mapping(bytes32 => Request) public requests;
    event Changed(bytes16 indexed licenseId, uint64 version, uint64 generation, uint8 operation);
    event Processed(bytes32 indexed key, bytes32 payload, uint64 version);

    constructor(address admin, uint32 maximum) {
        require(admin != address(0) && maximum > 0, "INVALID_POLICY");
        administrator = admin;
        maximumDevices = maximum;
    }
    function registerProduct(bytes16 product, address issuer) external {
        require(msg.sender == administrator, "ADMIN_REQUIRED");
        require(product != bytes16(0) && issuer != address(0) && issuers[product] == address(0), "INVALID_PRODUCT");
        issuers[product] = issuer;
    }
    function issue(bytes16 id, bytes16 product, address owner, uint64 expiresAt, uint32 maximum, bool transferable) external {
        require(issuers[product] == msg.sender, "ISSUER_REQUIRED");
        require(id != bytes16(0) && licenses[id].owner == address(0), "LICENSE_EXISTS");
        require(owner != address(0) && expiresAt > block.timestamp && maximum > 0 && maximum <= maximumDevices, "INVALID_POLICY");
        licenses[id] = License(product, msg.sender, owner, expiresAt, maximum, 0, false, transferable, 1, 1);
        emit Changed(id, 1, 1, 0);
    }
    function getLicense(bytes16 id) public view returns (License memory) {
        require(licenses[id].owner != address(0), "LICENSE_NOT_FOUND");
        return licenses[id];
    }
    function snapshot(bytes16 id, bytes32 device) external view returns (License memory license, bool active) {
        license = getLicense(id);
        active = members[id][license.generation][device];
    }
    function requestKey(address sender, bytes16 id, uint64 generation, bytes32 requestId) public pure returns (bytes32) {
        return keccak256(abi.encode(sender, id, generation, requestId));
    }
    function activate(bytes16 id, bytes32 device, uint64 generation, bytes32 requestId) external returns (uint64) {
        License storage l = licenses[id];
        require(l.owner != address(0), "LICENSE_NOT_FOUND");
        require(msg.sender == l.owner, "OWNER_REQUIRED");
        require(generation == l.generation, "GENERATION_CONFLICT");
        require(device != bytes32(0) && requestId != bytes32(0), "INVALID_REQUEST");
        bytes32 key = requestKey(msg.sender, id, generation, requestId);
        bytes32 payload = keccak256(abi.encode(msg.sig, id, device, generation));
        Request storage r = requests[key];
        if (r.processed) {
            require(r.payload == payload, "REQUEST_CONFLICT");
            return r.version; // Historical result, never evidence of current membership.
        }
        require(!l.revoked && block.timestamp < l.expiresAt, "LICENSE_INACTIVE");
        if (!members[id][generation][device]) {
            require(l.activeDevices < l.maxDevices, "DEVICE_LIMIT");
            members[id][generation][device] = true;
            l.activeDevices++;
            l.version++;
            emit Changed(id, l.version, generation, 1);
        }
        requests[key] = Request(payload, l.version, true);
        emit Processed(key, payload, l.version);
        return l.version;
    }
    function deactivate(bytes16 id, bytes32 device) external {
        License storage l = licenses[id];
        require(l.owner != address(0), "LICENSE_NOT_FOUND");
        require(msg.sender == l.owner || msg.sender == l.issuer, "ACTOR_REQUIRED");
        require(!l.revoked, "LICENSE_REVOKED");
        if (members[id][l.generation][device]) {
            members[id][l.generation][device] = false;
            l.activeDevices--;
            l.version++;
            emit Changed(id, l.version, l.generation, 2);
        }
    }
    function renew(bytes16 id, uint64 expiresAt) external {
        License storage l = licenses[id];
        require(l.owner != address(0), "LICENSE_NOT_FOUND");
        require(msg.sender == l.issuer, "ISSUER_REQUIRED");
        require(!l.revoked, "LICENSE_REVOKED");
        require(expiresAt > l.expiresAt && expiresAt > block.timestamp, "INVALID_EXPIRY");
        l.expiresAt = expiresAt;
        l.version++;
        emit Changed(id, l.version, l.generation, 3);
    }
    function transfer(bytes16 id, address owner) external {
        License storage l = licenses[id];
        require(l.owner != address(0), "LICENSE_NOT_FOUND");
        require(msg.sender == l.owner, "OWNER_REQUIRED");
        require(!l.revoked && block.timestamp < l.expiresAt, "LICENSE_INACTIVE");
        require(l.transferable && owner != address(0) && owner != l.owner, "TRANSFER_FORBIDDEN");
        l.owner = owner;
        l.generation++;
        l.activeDevices = 0;
        l.version++;
        emit Changed(id, l.version, l.generation, 4);
    }
    function revoke(bytes16 id) external {
        License storage l = licenses[id];
        require(l.owner != address(0), "LICENSE_NOT_FOUND");
        require(msg.sender == l.issuer, "ISSUER_REQUIRED");
        if (!l.revoked) {
            l.revoked = true;
            l.generation++;
            l.activeDevices = 0;
            l.version++;
            emit Changed(id, l.version, l.generation, 5);
        }
    }
}
