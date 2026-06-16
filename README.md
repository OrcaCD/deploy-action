# <div align="center"><img src="https://raw.githubusercontent.com/OrcaCD/orca-cd/f6fb48965df90a57a2b181e9e2b359653ae5c6b9/frontend/public/assets/logo-dark-256.png" width="100"/> <br>OrcaCD Deploy Action</div>

<br>

This GitHub Action allows you to trigger deployments using [OrcaCD](https://github.com/OrcaCD/orca-cd).
This is one additional way to trigger deployments, next to Webhooks, Polling or manual triggers, intended for greater flexibility or advanced use cases.

> [!WARNING]
> OrcaCD is in early development and not yet production-ready. There are no stable releases. Expect breaking changes at any time.

## Usage

This action requires a running instance of OrcaCD. For more information on how to set up OrcaCD, please refer to the [documentation](https://orcacd.dev).
The repository where you want to use the action must be connected to OrcaCD as a deployment source.
In addition, you need to enable GitHub Actions access per repository in the OrcaCD settings.

> [!NOTE]
> Do not forget to set the required permissions for the GitHub Actions job as described in the next section.

```yaml
- uses: OrcaCD/deploy-action@...
  with:
    # The OrcaCD hub URL (e.g., https://orca.example.com)
    # Required
    hub: https://orca.example.com

    # Whether to sync the repo content (compose files)
    # Optional, default: true
    syncRepo: true

    # Whether to pull the latest container image versions
    # Optional, default: false
    pullImages: false
```

## Required permissions

This action uses OpenID Connect (OIDC) to authenticate with OrcaCD without the need for long-lived credentials.
To use the action, you need to grant the following permissions to the GitHub Actions job:

```yaml
permissions:
  id-token: write
```

## Contribute

You're very welcome to contribute to OrcaCD! Please follow the [contribution guide](https://github.com/OrcaCD/deploy-action/blob/main/CONTRIBUTING.md) to get started. If you wish to contribute to the documentation head over to the [repository](https://github.com/OrcaCD/docs).
