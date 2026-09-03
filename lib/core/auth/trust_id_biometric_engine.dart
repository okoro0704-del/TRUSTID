import 'dart:async';

/// Registry-first Trust ID biometric engine.
///
/// Contract:
/// - Face + liveness are mandatory for enrollment and cross-device login.
/// - Fingerprint is local-only backup for already approved sessions.
/// - Unknown device + matched face => pending master approval.
class TrustIdBiometricEngine {
  TrustIdBiometricEngine({
    required this.registryApi,
    required this.faceCapture,
    required this.localBiometric,
    required this.masterPush,
  });

  final TrustIdRegistryApi registryApi;
  final FaceCaptureGateway faceCapture;
  final LocalBiometricGateway localBiometric;
  final MasterPushGateway masterPush;

  Future<AuthResult> authenticate({
    required String deviceInstallId,
    String? rememberedTrustId,
  }) async {
    final capture = await faceCapture.captureFaceWithLiveness();
    if (!capture.livenessPassed || capture.vector.length != 512) {
      return const AuthResult.error(
        code: 'face_required',
        message: 'Face/liveness verification failed.',
      );
    }

    final identify = await registryApi.identify(
      installId: deviceInstallId,
      vector: capture.vector,
      livenessScore: capture.livenessScore,
      confidence: capture.confidence,
    );

    if (identify.status == RegistryStatus.notRecognized) {
      return const AuthResult.error(
        code: 'face_not_recognized',
        message: 'This face is not recognized on this device.',
      );
    }

    if (identify.status == RegistryStatus.pendingMasterApproval) {
      await masterPush.awaitApproval(identify.approvalPollToken!);
      final claim = await registryApi.claimApproval(identify.approvalPollToken!);
      if (!claim.approved) {
        return const AuthResult.error(
          code: 'master_denied',
          message: 'Master device denied this login.',
        );
      }
      return AuthResult.approved(
        trustId: claim.trustId!,
        sessionToken: claim.sessionToken,
        switchedFrom: (rememberedTrustId != null && rememberedTrustId != claim.trustId)
            ? rememberedTrustId
            : null,
      );
    }

    final switched = rememberedTrustId != null && rememberedTrustId != identify.trustId;
    return AuthResult.approved(
      trustId: identify.trustId!,
      sessionToken: identify.sessionToken,
      switchedFrom: switched ? rememberedTrustId : null,
    );
  }

  /// Local backup path: only valid if an active session already exists.
  Future<bool> unlockWithFingerprint({
    required bool hasApprovedSession,
    String reason = 'Unlock Trust ID',
  }) async {
    if (!hasApprovedSession) return false;
    return localBiometric.authenticateFingerprint(reason: reason);
  }
}

class FaceCaptureResult {
  const FaceCaptureResult({
    required this.vector,
    required this.confidence,
    required this.livenessScore,
    required this.livenessPassed,
  });

  final List<double> vector;
  final double confidence;
  final double livenessScore;
  final bool livenessPassed;
}

enum RegistryStatus { approved, pendingMasterApproval, notRecognized }

class RegistryIdentifyResult {
  const RegistryIdentifyResult({
    required this.status,
    this.trustId,
    this.sessionToken,
    this.approvalPollToken,
  });

  final RegistryStatus status;
  final String? trustId;
  final String? sessionToken;
  final String? approvalPollToken;
}

class ApprovalClaimResult {
  const ApprovalClaimResult({
    required this.approved,
    this.trustId,
    this.sessionToken,
  });

  final bool approved;
  final String? trustId;
  final String? sessionToken;
}

class AuthResult {
  const AuthResult._({
    required this.ok,
    this.trustId,
    this.sessionToken,
    this.switchedFrom,
    this.errorCode,
    this.errorMessage,
  });

  const AuthResult.approved({
    required String trustId,
    String? sessionToken,
    String? switchedFrom,
  }) : this._(
          ok: true,
          trustId: trustId,
          sessionToken: sessionToken,
          switchedFrom: switchedFrom,
        );

  const AuthResult.error({
    required String code,
    required String message,
  }) : this._(
          ok: false,
          errorCode: code,
          errorMessage: message,
        );

  final bool ok;
  final String? trustId;
  final String? sessionToken;
  final String? switchedFrom;
  final String? errorCode;
  final String? errorMessage;
}

abstract class FaceCaptureGateway {
  Future<FaceCaptureResult> captureFaceWithLiveness();
}

abstract class LocalBiometricGateway {
  Future<bool> authenticateFingerprint({required String reason});
}

abstract class MasterPushGateway {
  Future<void> awaitApproval(String pollToken);
}

abstract class TrustIdRegistryApi {
  Future<RegistryIdentifyResult> identify({
    required String installId,
    required List<double> vector,
    required double livenessScore,
    double? confidence,
  });

  Future<ApprovalClaimResult> claimApproval(String pollToken);
}
