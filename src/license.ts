import nacl from "tweetnacl";

// Offline Ed25519 license verification for Periodic Notes Synthesizer.
// A license key is base64(JSON({ p, s })) where:
//   p = base64 of the UTF-8 payload JSON
//   s = base64 of the Ed25519 detached signature over the payload bytes
// Verification is fully offline against the embedded public key.

const EMBEDDED_PUBLIC_KEY = "KvULUdcXqG+AywX1laqhN9Ij+VcXx7ermKaNCi3umek=";

export interface LicenseStatus {
	valid: boolean;
	email?: string;
}

function b64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function bytesToUtf8(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

export function verifyLicense(licenseKey: string): LicenseStatus {
	const key = (licenseKey || "").trim();
	if (!key) {
		return { valid: false };
	}

	try {
		const bundleJson = bytesToUtf8(b64ToBytes(key));
		const bundle: unknown = JSON.parse(bundleJson);
		if (typeof bundle !== "object" || bundle === null) {
			return { valid: false };
		}
		const obj = bundle as Record<string, unknown>;
		const p = obj["p"];
		const s = obj["s"];
		if (typeof p !== "string" || typeof s !== "string") {
			return { valid: false };
		}

		const payloadBytes = b64ToBytes(p);
		const signature = b64ToBytes(s);
		const publicKey = b64ToBytes(EMBEDDED_PUBLIC_KEY);

		const signatureOk = nacl.sign.detached.verify(
			payloadBytes,
			signature,
			publicKey
		);
		if (!signatureOk) {
			return { valid: false };
		}

		const payload: unknown = JSON.parse(bytesToUtf8(payloadBytes));
		let email: string | undefined;
		if (typeof payload === "object" && payload !== null) {
			const value = (payload as Record<string, unknown>)["email"];
			if (typeof value === "string") {
				email = value;
			}
		}

		return { valid: true, email };
	} catch {
		return { valid: false };
	}
}
