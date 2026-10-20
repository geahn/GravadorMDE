# Gravador de Aulas

App para Windows 10/11 (64 bits) que grava **tela + câmera + microfone**, edita e exporta videoaulas leves em MP4, e envia direto para o painel de aulas da **Comunidade MDE**.

## Instalar (equipe)

1. Rode `Gravador-de-Aulas-Setup-<versão>.exe`. O Windows pode mostrar "O Windows protegeu o computador": clique em **Mais informações → Executar assim mesmo** (o instalador não tem assinatura digital).
2. Ao abrir pela primeira vez, o app já vem com os layouts, a intro, o vídeo de transição e as configurações padrão da equipe.
3. Escolha sua tela, câmera e microfone.
4. Em **Configurações → Comunidade MDE**, cole a **sua** chave de API (Admin → Chaves de API no painel do MDE) e clique em **Salvar e testar**.

Se a câmera ou o microfone não aparecerem: Configurações do Windows → Privacidade → Câmera/Microfone → permitir que **aplicativos da área de trabalho** acessem.

## Recursos

- **Gravação**: layouts horizontais (16:9) e verticais (9:16), cada um com seus ajustes; troca de layout ao vivo (`Alt+Shift+1…9`); 1 arquivo ou 3 (final + câmera + tela); **selecionar só uma área da tela**; logo/marca d'água; áudio do computador; contagem regressiva; barra flutuante que não aparece no vídeo; o PC não dorme durante a gravação; avisos de pouco espaço em disco e de microfone sem som.
- **Roteiro**: janela flutuante com rolagem automática (teleprompter), invisível na gravação.
- **Editor**: cortes reais com prévia sem engasgos; remover pausas automaticamente; transições "alguns momentos depois"; intro automática; ajuste de sincronia da voz com a boca; `J`/`K`/`L` (voltar / pausar / acelerar).
- **Vídeo final**: H.264 compacto (≈100–500 MB por hora), áudio nivelado em −16 LUFS sem estourar.
- **Galeria**: assistir, editar, renomear, excluir e ver o status de envio ao MDE.

### Novidades da 2.0

- **Cenas**: no editor, *Gravar nova cena* volta ao estúdio e a próxima gravação entra no fim da aula. Cada cena vira um bloco na faixa **Cenas** da linha do tempo: arraste para reordenar (ou use a aba Cenas), renomeie, remova.
- **Zoom**: selecione um trecho (ou deixe a agulha) e aperte `Z`. Dois modos: **ponto fixo** (arraste o retângulo na prévia) ou **seguir o mouse** (o app grava a posição do mouse durante a gravação de tela; a câmera virtual acompanha com suavidade). Aproximação de 1,1× a 5× com ajuste fino, suavidade da entrada/saída e tempo editável na faixa **Zoom**.
- **Textos, imagens, vídeos, GIFs e stickers** por cima da aula (`X` insere texto): 54 estilos prontos, fontes do Windows (ou as instaladas no PC), tamanho, peso, itálico, sublinhado, maiúsculas, alinhamento, espaçamento, cor ou degradê, fundo em caixa/pílula/por linha, contorno, borda, sombra, brilho neon, rotação, opacidade e animação de entrada/saída. Salve seus próprios estilos. Arraste, redimensione e gire direto na prévia.
- **Ao vivo**: textos, imagens e stickers que entram na gravação em tempo real; mostre/esconda pelo estúdio, pela barra flutuante ou `Alt+Shift+T`.
- **Fundos com imagem**: suas imagens (com desfoque) ou fundos gerados (malha, aurora, pôr do sol, pontos, grade, papel).
- **Filtros de cor**: 20 prontos + os seus (salvos e editáveis). Aplique no vídeo inteiro, num trecho (faixa **Filtros**) ou direto na câmera ao vivo.
- **Áudio**: master, microfone, áudio do computador (gravados separados para equilibrar depois), vídeos inseridos; equalizador de grave/médio/agudo com presets; redução de ruído em 3 níveis e silenciador entre falas; prévia de 10 s; **baixar só o áudio editado** (MP3, WAV ou M4A).
- **Velocidade**: do vídeo inteiro (0,25× a 4×, ajuste fino de 0,01) e por trecho; vale na prévia e na exportação, sem mudar o tom da voz.

Tudo é processado localmente (FFmpeg). Prévia e exportação usam a mesma matemática, então o que você vê é o que sai no arquivo.

## Atalhos

| Atalho | Ação |
| --- | --- |
| `Alt+Shift+R` | Iniciar / parar a gravação |
| `Alt+Shift+P` | Pausar / continuar |
| `Alt+Shift+1…9` | Trocar de layout |
| `Espaço`, `J`/`K`/`L` | Editor: tocar, voltar, pausar, acelerar |
| `Del`, `Q`, `W`, `T` | Editor: remover seleção (ou o item selecionado), cortar início/fim, inserir transição |
| `Z`, `X`, `Ctrl+D` | Editor: adicionar zoom, adicionar texto, duplicar item |
| `Alt+Shift+T` | Mostrar / esconder textos e imagens ao vivo |

## Desenvolvimento

```bash
npm install
npm start                         # roda o app
node scripts/export-defaults.js   # usa as configurações deste PC como padrão da equipe
npm run dist                      # gera o instalador em dist/
```

`build/defaults/` guarda os padrões que vão no instalador (layouts, preferências e as mídias de intro/transição/logo). As mídias não ficam no repositório: rode `node scripts/export-defaults.js` no PC com as configurações desejadas antes de gerar o instalador.

Requisitos para desenvolver: Node.js 20+ e Windows 10/11 (o app usa captura de tela e APIs do Windows).

## Privacidade

O app não tem telemetria, analytics nem atualização automática. A única comunicação com a internet é o envio opcional à Comunidade MDE (`mde.js`), que só acontece com uma chave de API cadastrada em **Configurações → Comunidade MDE**: o vídeo final exportado e o título vão para a API do MDE e o arquivo para o servidor de vídeo dele. Sem chave, nada sai do computador.

## Licença

[MIT](LICENSE)
