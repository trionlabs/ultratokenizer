//! Direct external-write calls with no application-level retry.

use prost::Message;
use reqwest::{redirect::Policy, Client, Url};
use serde::Serialize;
use sp1_sdk::network::{
    proto::{
        artifact::{
            artifact_store_client::ArtifactStoreClient, ArtifactType, CreateArtifactRequest,
        },
        network::prover_network_client::ProverNetworkClient,
        types::{
            CreateProgramRequest, CreateProgramRequestBody, CreateProgramResponse, MessageFormat,
        },
    },
    signer::NetworkSigner,
};
use std::time::Duration;
use tonic::transport::{Channel, ClientTlsConfig, Endpoint};

pub struct ArtifactAllocation {
    pub uri: String,
    presigned_url: String,
}

pub struct DirectNetwork {
    signer: NetworkSigner,
    channel: Channel,
    http: Client,
}

impl DirectNetwork {
    pub async fn connect(signer: NetworkSigner, rpc_url: &str) -> Result<Self, &'static str> {
        let endpoint = Endpoint::new(rpc_url.to_owned())
            .map_err(|_| "Succinct RPC endpoint is invalid.")?
            .timeout(Duration::from_secs(60))
            .connect_timeout(Duration::from_secs(15))
            .keep_alive_while_idle(true)
            .http2_keep_alive_interval(Duration::from_secs(15))
            .keep_alive_timeout(Duration::from_secs(15))
            .tcp_keepalive(Some(Duration::from_secs(60)))
            .tcp_nodelay(true)
            .tls_config(ClientTlsConfig::new().with_enabled_roots())
            .map_err(|_| "Unable to configure Succinct RPC TLS.")?;
        let channel = endpoint
            .connect()
            .await
            .map_err(|_| "Unable to connect to Succinct RPC.")?;
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .redirect(Policy::none())
            .pool_max_idle_per_host(0)
            .pool_idle_timeout(Duration::from_secs(240))
            .build()
            .map_err(|_| "Unable to create artifact upload client.")?;
        Ok(Self {
            signer,
            channel,
            http,
        })
    }

    pub async fn allocate_artifact_once(
        &self,
        artifact_type: ArtifactType,
    ) -> Result<ArtifactAllocation, &'static str> {
        let signature = artifact_signature(&self.signer).await?;
        let mut store = ArtifactStoreClient::new(self.channel.clone());
        let response = store
            .create_artifact(CreateArtifactRequest {
                artifact_type: artifact_type.into(),
                signature,
            })
            .await
            .map_err(|_| "Succinct artifact allocation failed or was ambiguous.")?
            .into_inner();
        if response.artifact_uri.is_empty()
            || response.artifact_uri.len() > 2_048
            || response.artifact_presigned_url.is_empty()
            || response.artifact_presigned_url.len() > 16_384
        {
            return Err("Succinct returned an incomplete artifact allocation.");
        }
        validate_presigned_url(&response.artifact_presigned_url)?;
        Ok(ArtifactAllocation {
            uri: response.artifact_uri,
            presigned_url: response.artifact_presigned_url,
        })
    }

    pub async fn upload_artifact_once(
        &self,
        allocation: &ArtifactAllocation,
        payload: Vec<u8>,
    ) -> Result<(), &'static str> {
        let response = self
            .http
            .put(&allocation.presigned_url)
            .body(payload)
            .send()
            .await
            .map_err(|_| "Succinct artifact upload failed or was ambiguous.")?;
        if !response.status().is_success() {
            return Err("Succinct artifact upload returned a failure status.");
        }
        Ok(())
    }

    pub async fn create_program_once(
        &self,
        body: CreateProgramRequestBody,
    ) -> Result<CreateProgramResponse, &'static str> {
        let signature = proto_signature(&body, &self.signer).await?;
        let mut rpc = ProverNetworkClient::new(self.channel.clone());
        rpc.create_program(CreateProgramRequest {
            format: MessageFormat::Binary.into(),
            signature,
            body: Some(body),
        })
        .await
        .map(|response| response.into_inner())
        .map_err(|_| "Succinct program registration failed or was ambiguous.")
    }
}

fn validate_presigned_url(value: &str) -> Result<(), &'static str> {
    let url = Url::parse(value).map_err(|_| "Succinct returned an invalid artifact upload URL.")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Succinct artifact upload URL violates the HTTPS boundary.");
    }
    Ok(())
}

pub fn encode_artifact<T: Serialize>(value: &T) -> Result<Vec<u8>, &'static str> {
    let serialized = bincode::serialize(value).map_err(|_| "Unable to encode SP1 artifact.")?;
    zstd::encode_all(serialized.as_slice(), 3).map_err(|_| "Unable to compress SP1 artifact.")
}

pub fn encoded_message_sha256<M: Message>(message: &M) -> String {
    crate::sha256_hex(&message.encode_to_vec())
}

async fn proto_signature<M: Message>(
    message: &M,
    signer: &NetworkSigner,
) -> Result<Vec<u8>, &'static str> {
    signer
        .sign_message(&message.encode_to_vec())
        .await
        .map(|signature| signature.as_bytes().to_vec())
        .map_err(|_| "Unable to sign Succinct protobuf message.")
}

async fn artifact_signature(signer: &NetworkSigner) -> Result<Vec<u8>, &'static str> {
    let signature = signer
        .sign_message(b"create_artifact")
        .await
        .map_err(|_| "Unable to sign Succinct artifact allocation.")?;
    let bytes = signature.as_bytes();
    if bytes.len() != 65 {
        return Err("Succinct artifact signature has an invalid length.");
    }
    let mut result = bytes[..64].to_vec();
    result.push(
        bytes[64]
            .checked_add(27)
            .ok_or("Succinct artifact signature recovery ID overflowed.")?,
    );
    Ok(result)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use super::*;

    #[test]
    fn artifact_encoding_is_deterministic() {
        let first = encode_artifact(&vec![1_u8, 2, 3]).expect("fixture encodes");
        let second = encode_artifact(&vec![1_u8, 2, 3]).expect("fixture encodes");
        assert_eq!(first, second);
        assert_ne!(
            first,
            encode_artifact(&vec![1_u8, 2, 4]).expect("fixture encodes")
        );
    }

    #[test]
    fn upload_urls_require_direct_https_without_embedded_credentials() {
        assert!(validate_presigned_url("https://artifacts.example/input?signature=1").is_ok());
        assert!(validate_presigned_url("http://artifacts.example/input").is_err());
        assert!(validate_presigned_url("https://user@artifacts.example/input").is_err());
        assert!(validate_presigned_url("https://artifacts.example/input#fragment").is_err());
    }
}
