import {
  DEFAULT_JWT_PROOF_TYPE,
  IIdentifierOpts,
  VerifiableCredentialsWithDefinition,
  VerifiablePresentationWithDefinition,
} from '../types/IDidAuthSiopOpAuthenticator'
import { OpSession } from './OpSession'
import { CredentialMapper, W3CVerifiableCredential } from '@sphereon/ssi-types'
import { PresentationDefinitionWithLocation, PresentationExchange } from '@sphereon/did-auth-siop'
import { SelectResults, Status, SubmissionRequirementMatch } from '@sphereon/pex'

import { ProofOptions } from '@sphereon/ssi-sdk.core'
import { createOID4VPPresentationSignCallback } from './functions'
import { FindCredentialsArgs, IIdentifier } from '@veramo/core'
import { determineKid, getKey } from '@sphereon/ssi-sdk-ext.did-utils'
import { Format } from '@sphereon/pex-models'

export class OID4VP {
  private readonly session: OpSession
  private readonly allDIDs: string[]

  private constructor(session: OpSession, allDIDs?: string[]) {
    this.session = session
    this.allDIDs = allDIDs ?? []
  }

  public static async init(session: OpSession, allDIDs: string[]): Promise<OID4VP> {
    return new OID4VP(session, allDIDs ?? (await session.getSupportedDIDs()))
  }

  public async getPresentationDefinitions(): Promise<PresentationDefinitionWithLocation[] | undefined> {
    const definitions = (await this.session.getAuthorizationRequest()).presentationDefinitions
    if (definitions) {
      PresentationExchange.assertValidPresentationDefinitionWithLocations(definitions)
    }
    return definitions
  }

  private getPresentationExchange(verifiableCredentials: W3CVerifiableCredential[], allDIDs?: string[]): PresentationExchange {
    return new PresentationExchange({
      allDIDs: allDIDs ?? this.allDIDs,
      allVerifiableCredentials: verifiableCredentials,
    })
  }

  public async createVerifiablePresentations(
    credentialsWithDefinitions: VerifiableCredentialsWithDefinition[],
    opts?: {
      restrictToFormats?: Format
      restrictToDIDMethods?: string[]
      proofOpts?: ProofOptions
      identifierOpts?: IIdentifierOpts
      holderDID?: string
      subjectIsHolder?: boolean
    }
  ): Promise<VerifiablePresentationWithDefinition[]> {
    return await Promise.all(credentialsWithDefinitions.map((cred) => this.createVerifiablePresentation(cred, opts)))
  }

  public async createVerifiablePresentation(
    selectedVerifiableCredentials: VerifiableCredentialsWithDefinition,
    opts?: {
      restrictToFormats?: Format
      restrictToDIDMethods?: string[]
      proofOpts?: ProofOptions
      identifierOpts?: IIdentifierOpts
      holderDID?: string
      subjectIsHolder?: boolean
    }
  ): Promise<VerifiablePresentationWithDefinition> {
    if (opts?.subjectIsHolder && opts?.holderDID) {
      throw Error('Cannot both have subject is issuer and a holderDID value at the same time (programming error)')
    } else if (
      !selectedVerifiableCredentials ||
      !selectedVerifiableCredentials.credentials ||
      selectedVerifiableCredentials.credentials.length === 0
    ) {
      throw Error('No verifiable verifiableCredentials provided for presentation definition')
    }

    let id: IIdentifier | undefined = opts?.identifierOpts?.identifier
    if (!opts?.identifierOpts?.identifier) {
      if (opts?.subjectIsHolder) {
        const firstVC = CredentialMapper.toUniformCredential(selectedVerifiableCredentials.credentials[0])
        const holder = Array.isArray(firstVC.credentialSubject) ? firstVC.credentialSubject[0].id : firstVC.credentialSubject.id
        if (holder) {
          id = await this.session.context.agent.didManagerGet({ did: holder })
        }
      } else if (opts?.holderDID) {
        id = await this.session.context.agent.didManagerGet({ did: opts.holderDID })
      }
    }

    const idOpts = opts?.identifierOpts ?? { identifier: id! }
    this.assertIdentifier(idOpts.identifier)

    // We are making sure to filter, in case the user submitted all verifiableCredentials in the wallet/agent. We also make sure to get original formats back
    const vcs = await this.filterCredentials(selectedVerifiableCredentials.definition, {
      restrictToFormats: opts?.restrictToFormats,
      restrictToDIDMethods: opts?.restrictToDIDMethods,
      filterOpts: {
        verifiableCredentials: selectedVerifiableCredentials.credentials.map((vc) => CredentialMapper.storedCredentialToOriginalFormat(vc)),
      },
    })
    const key = await getKey(idOpts.identifier, 'authentication', this.session.context, idOpts.kid)
    const signCallback = await createOID4VPPresentationSignCallback({
      presentationSignCallback: this.session.options.presentationSignCallback,
      kid: determineKid(key, idOpts),
      context: this.session.context,
      format: opts?.restrictToFormats ?? selectedVerifiableCredentials.definition.definition.format,
    })
    const presentationResult = await this.getPresentationExchange(vcs.credentials, this.allDIDs).createVerifiablePresentation(
      vcs.definition.definition,
      vcs.credentials,
      signCallback,
      {
        proofOptions: opts?.proofOpts,
        holderDID: idOpts.identifier.did,
      }
    )

    return {
      ...presentationResult,
      verifiableCredentials: vcs.credentials,
      definition: selectedVerifiableCredentials.definition,
      identifierOpts: idOpts,
    }
  }

  public async filterCredentialsAgainstAllDefinitions(opts?: {
    filterOpts?: { verifiableCredentials?: W3CVerifiableCredential[]; filter?: FindCredentialsArgs }
    holderDIDs?: string[]
    restrictToFormats?: Format
    restrictToDIDMethods?: string[]
  }): Promise<VerifiableCredentialsWithDefinition[]> {
    const defs = await this.getPresentationDefinitions()
    const result: VerifiableCredentialsWithDefinition[] = []
    if (defs) {
      for (const definition of defs) {
        result.push(await this.filterCredentials(definition, opts))
      }
    }
    return result
  }

  public async filterCredentials(
    presentationDefinition: PresentationDefinitionWithLocation,
    opts?: {
      filterOpts?: { verifiableCredentials?: W3CVerifiableCredential[]; filter?: FindCredentialsArgs }
      holderDIDs?: string[]
      restrictToFormats?: Format
      restrictToDIDMethods?: string[]
    }
  ): Promise<VerifiableCredentialsWithDefinition> {
    return {
      definition: presentationDefinition,
      credentials: (await this.filterCredentialsWithSelectionStatus(presentationDefinition, opts)).verifiableCredential as W3CVerifiableCredential[],
    }
  }

  public async filterCredentialsWithSelectionStatus(
    presentationDefinition: PresentationDefinitionWithLocation,
    opts?: {
      filterOpts?: { verifiableCredentials?: W3CVerifiableCredential[]; filter?: FindCredentialsArgs }
      holderDIDs?: string[]
      restrictToFormats?: Format
      restrictToDIDMethods?: string[]
    }
  ): Promise<SelectResults> {
    const selectionResults: SelectResults = await this.getPresentationExchange(
      await this.getCredentials(opts?.filterOpts)
    ).selectVerifiableCredentialsForSubmission(presentationDefinition.definition, opts)
    if (selectionResults.errors && selectionResults.errors.length > 0) {
      throw Error(JSON.stringify(selectionResults.errors))
    } else if (selectionResults.areRequiredCredentialsPresent === Status.ERROR) {
      throw Error(`Not all required credentials are available to satisfy the relying party's request`)
    }

    const matches: SubmissionRequirementMatch[] | undefined = selectionResults.matches
    if (!matches || matches.length === 0 || !selectionResults.verifiableCredential || selectionResults.verifiableCredential.length === 0) {
      throw Error(JSON.stringify(selectionResults.errors))
    }
    return selectionResults
  }

  private async getCredentials(filterOpts?: {
    verifiableCredentials?: W3CVerifiableCredential[]
    filter?: FindCredentialsArgs
  }): Promise<W3CVerifiableCredential[]> {
    if (filterOpts?.verifiableCredentials && filterOpts.verifiableCredentials.length > 0) {
      return filterOpts.verifiableCredentials
    }
    return (await this.session.context.agent.dataStoreORMGetVerifiableCredentials(filterOpts?.filter))
      .map((uniqueVC) => uniqueVC.verifiableCredential)
      .map((vc) => (vc.proof && vc.proof.type === DEFAULT_JWT_PROOF_TYPE ? vc.proof.jwt : vc))
  }

  private assertIdentifier(identifier?: IIdentifier): void {
    if (!identifier) {
      throw Error(`OID4VP needs an identifier at this point`)
    }
  }
}
