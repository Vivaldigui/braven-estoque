# Estoque BRAVEN

Controle de estoque simples, com login e senha, feito para usar no celular.
Já vem com todos os produtos do catálogo cadastrados (estoque zerado).

## Como a Lili usa

- **Vendi**: toca no botão laranja ao lado do tamanho, escolhe quantas peças e confirma. O estoque baixa na hora.
- **+ (Chegou)**: quando chegar mercadoria, toca no **+** e informa quantas peças entraram.
- **Contei**: dentro do mesmo botão, serve para acertar o número depois de contar as peças na mão.
- **Desfazer**: errou? Aparece "Desfazer" logo depois da baixa, e também na aba Histórico.
- **Cores**: verde = tem estoque, amarelo = acabando, vermelho = esgotado.
  Os cartões "acabando" e "esgotados" no topo filtram a lista.
- **Histórico**: mostra cada venda e entrada, com data, hora, quem fez e o cliente.
- **Mais**: cadastrar produto novo, baixar planilha (abre no Excel), trocar senha e dar acesso a outra pessoa (ex.: Jo).
- Para editar ou apagar um produto, toque no nome dele.

Dica: no celular, abra o endereço e use "Adicionar à tela inicial". Vira um app.

## Rodar no computador

```
node server.js
```

Abre em http://localhost:3000. No primeiro acesso, o usuário é `lili` e a senha aparece no terminal
(ou defina `ADMIN_USER` e `ADMIN_PASS` antes de rodar). Os dados ficam em `data/db.json`.

## Colocar no ar (Easypanel)

1. Crie um serviço "App" apontando para esta pasta (tem `Dockerfile`).
2. Monte um volume em `/data` (sem isso, os dados somem a cada deploy).
3. Variáveis: `ADMIN_USER=lili`, `ADMIN_PASS=<senha inicial>`, `COOKIE_SECURE=1`.
4. Porta 3000 e um domínio com HTTPS (ex.: estoque.braven...).

Backup: basta copiar o arquivo `/data/db.json`.
