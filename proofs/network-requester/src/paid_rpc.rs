//! Raw auction protobuf transport. There is one call site for request_proof and no retry.

use sp1_sdk::network::{
    proto::auction::{network::prover_network_client::ProverNetworkClient, types as rpc},
    signer::NetworkSigner,
    NetworkMode,
};
use std::time::Duration;
use tonic::transport::{Channel, ClientTlsConfig, Endpoint};

pub trait PaidRpc {
    async fn params(&mut self) -> Result<rpc::GetProofRequestParamsResponse, &'static str>;
    async fn program(&mut self, vk_hash: Vec<u8>) -> Result<Option<rpc::Program>, &'static str>;
    async fn balance(&mut self, requester: Vec<u8>) -> Result<String, &'static str>;
    async fn nonce(&mut self, requester: Vec<u8>) -> Result<u64, &'static str>;
    async fn submit_once(
        &mut self,
        request: rpc::RequestProofRequest,
    ) -> Result<rpc::RequestProofResponse, &'static str>;
    async fn requests(
        &mut self,
        filter: rpc::GetFilteredProofRequestsRequest,
    ) -> Result<Vec<rpc::ProofRequest>, &'static str>;
    async fn request(&mut self, id: Vec<u8>) -> Result<Option<rpc::ProofRequest>, &'static str>;
    async fn transaction(
        &mut self,
        hash: Vec<u8>,
    ) -> Result<Option<rpc::TransactionDetails>, &'static str>;
    async fn status(
        &mut self,
        id: Vec<u8>,
    ) -> Result<rpc::GetProofRequestStatusResponse, &'static str>;
}

pub trait PaidSigner {
    fn address(&self) -> String;
    async fn sign(&self, body: &[u8]) -> Result<Vec<u8>, &'static str>;
}

impl PaidSigner for NetworkSigner {
    fn address(&self) -> String {
        format!("{:#x}", self.address())
    }
    async fn sign(&self, body: &[u8]) -> Result<Vec<u8>, &'static str> {
        self.sign_message(body)
            .await
            .map(|value| value.as_bytes().to_vec())
            .map_err(|_| {
                "Unable to sign the durable paid intent; do not obtain a replacement nonce."
            })
    }
}

pub struct DirectPaidRpc {
    channel: Channel,
}

impl DirectPaidRpc {
    pub async fn connect() -> Result<Self, &'static str> {
        // This is a separately bounded mainnet protocol; arbitrary endpoints and network
        // variants are not accepted through settings or a preparation journal.
        let endpoint = Endpoint::new(
            sp1_sdk::network::get_default_rpc_url_for_mode(NetworkMode::Mainnet).to_owned(),
        )
        .map_err(|_| "Pinned Succinct endpoint is invalid.")?
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .tls_config(ClientTlsConfig::new().with_enabled_roots())
        .map_err(|_| "Unable to configure paid request TLS.")?;
        Ok(Self {
            channel: endpoint
                .connect()
                .await
                .map_err(|_| "Unable to connect to Succinct; no request was sent.")?,
        })
    }

    fn client(&self) -> ProverNetworkClient<Channel> {
        ProverNetworkClient::new(self.channel.clone()).max_decoding_message_size(1024 * 1024)
    }
}

impl PaidRpc for DirectPaidRpc {
    async fn params(&mut self) -> Result<rpc::GetProofRequestParamsResponse, &'static str> {
        self.client()
            .get_proof_request_params(rpc::GetProofRequestParamsRequest {
                mode: rpc::ProofMode::Groth16.into(),
            })
            .await
            .map(|v| v.into_inner())
            .map_err(|_| "Fresh auction parameter read is unavailable; no request was sent.")
    }
    async fn program(&mut self, vk_hash: Vec<u8>) -> Result<Option<rpc::Program>, &'static str> {
        self.client()
            .get_program(rpc::GetProgramRequest { vk_hash })
            .await
            .map(|v| v.into_inner().program)
            .map_err(|_| "Fresh program registration read is unavailable; no request was sent.")
    }
    async fn balance(&mut self, address: Vec<u8>) -> Result<String, &'static str> {
        self.client()
            .get_balance(rpc::GetBalanceRequest { address })
            .await
            .map(|v| v.into_inner().amount)
            .map_err(|_| "Fresh requester balance read is unavailable; no request was sent.")
    }
    async fn nonce(&mut self, address: Vec<u8>) -> Result<u64, &'static str> {
        self.client()
            .get_nonce(rpc::GetNonceRequest { address })
            .await
            .map(|v| v.into_inner().nonce)
            .map_err(|_| "Requester nonce read is unavailable; no request was sent.")
    }
    async fn submit_once(
        &mut self,
        request: rpc::RequestProofRequest,
    ) -> Result<rpc::RequestProofResponse, &'static str> {
        self.client().request_proof(request).await.map(|v| v.into_inner())
            .map_err(|_| "Paid submission response is ambiguous; recover the recorded request and never resubmit.")
    }
    async fn requests(
        &mut self,
        filter: rpc::GetFilteredProofRequestsRequest,
    ) -> Result<Vec<rpc::ProofRequest>, &'static str> {
        self.client()
            .get_filtered_proof_requests(filter)
            .await
            .map(|v| v.into_inner().requests)
            .map_err(|_| {
                "Request recovery lookup is unavailable; the paid budget remains encumbered."
            })
    }
    async fn request(
        &mut self,
        request_id: Vec<u8>,
    ) -> Result<Option<rpc::ProofRequest>, &'static str> {
        self.client()
            .get_proof_request_details(rpc::GetProofRequestDetailsRequest { request_id })
            .await
            .map(|v| v.into_inner().request)
            .map_err(|_| "Known request details are unavailable; do not resubmit.")
    }
    async fn transaction(
        &mut self,
        tx_hash: Vec<u8>,
    ) -> Result<Option<rpc::TransactionDetails>, &'static str> {
        self.client()
            .get_transaction_details(rpc::GetTransactionDetailsRequest { tx_hash })
            .await
            .map(|v| v.into_inner().transaction)
            .map_err(|_| "Exact nonce and signature recovery evidence is unavailable.")
    }
    async fn status(
        &mut self,
        request_id: Vec<u8>,
    ) -> Result<rpc::GetProofRequestStatusResponse, &'static str> {
        self.client()
            .get_proof_request_status(rpc::GetProofRequestStatusRequest { request_id })
            .await
            .map(|v| v.into_inner())
            .map_err(|_| "Recovered request status is unavailable; do not resubmit.")
    }
}
